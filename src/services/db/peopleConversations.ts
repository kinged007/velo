/**
 * People Conversations — a grouping mode that aggregates emails by the set of
 * participants involved (independent of subject/thread-id).
 *
 * The index is built on demand when the user switches to "people" grouping mode
 * and can be refreshed after each sync cycle.
 */

import { getDb } from "./connection";
import type { DbMessage } from "./messages";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Prefix used to identify people conversation IDs, preventing collision with thread IDs. */
export const PEOPLE_CONV_ID_PREFIX = "pconv:";

/** Default number of messages to scan when building the index. */
const DEFAULT_MESSAGE_LIMIT = 5000;

/** Default lookback window for index builds (30 days in milliseconds). */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Regex to strip plus-addressing from an email (e.g. "name+tag@domain" → "name@domain"). */
const PLUS_ADDRESS_RE = /\+[^@]*@/;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PeopleConversation {
  id: string;
  account_id: string;
  participants_key: string;
  title: string | null;
  last_message_at: number;
  unread_count: number;
  message_count: number;
  is_archived: number;
  is_trashed: number;
  is_favorite: number;
}

export interface PeopleConversationMessage {
  conversation_id: string;
  account_id: string;
  message_id: string;
  received_at: number;
}

// ─── Participant helpers ───────────────────────────────────────────────────────

/**
 * Parse a comma-separated list of RFC-5322-style addresses and return a Set of
 * lowercased bare email addresses.
 *
 * Handles:
 *   "Name <addr@example.com>"   → "addr@example.com"
 *   "addr@example.com"          → "addr@example.com"
 *   Multiple addresses separated by ","
 */
export function parseAddresses(raw: string | null): Set<string> {
  if (!raw) return new Set();
  const result = new Set<string>();
  // Split on commas that are NOT inside angle brackets
  const parts = raw.split(/,(?![^<]*>)/);
  for (const part of parts) {
    const trimmed = part.trim();
    const angleMatch = trimmed.match(/<([^>]+)>/);
    const email = angleMatch ? angleMatch[1]! : trimmed;
    const normalised = email.toLowerCase().trim();
    if (normalised.includes("@")) result.add(normalised);
  }
  return result;
}

/**
 * Build the canonical participants key for a message.
 *
 * - Collects from + to + cc addresses.
 * - Removes the user's own email so the key represents "the other people".
 * - Returns addresses sorted lexicographically and joined with ",".
 */
export function buildParticipantsKey(
  fromAddress: string | null,
  toAddresses: string | null,
  ccAddresses: string | null,
  userEmail: string,
): string {
  const all = new Set<string>();
  for (const addr of parseAddresses(fromAddress)) all.add(addr);
  for (const addr of parseAddresses(toAddresses)) all.add(addr);
  for (const addr of parseAddresses(ccAddresses)) all.add(addr);

  // Remove the user's own address(es) — support plus-addressing variants
  const userBase = userEmail.toLowerCase().replace(PLUS_ADDRESS_RE, "@");
  for (const addr of all) {
    const addrBase = addr.replace(PLUS_ADDRESS_RE, "@");
    if (addrBase === userBase) {
      all.delete(addr);
    }
  }

  if (all.size === 0) {
    // Edge case: self-email or empty headers — use own address as key
    all.add(userEmail.toLowerCase());
  }

  return [...all].sort().join(",");
}

/**
 * Build a human-readable title from the participants key.
 * Uses display names from the message if available; falls back to email
 * addresses, shortened to local-part for long lists.
 */
export function buildTitle(
  participantsKey: string,
  displayNames: Map<string, string>,
): string {
  const addrs = participantsKey.split(",");
  const labels = addrs.map((addr) => {
    const name = displayNames.get(addr);
    if (name && name.trim().length > 0) return name.trim();
    // Shorten to local-part for brevity
    const local = addr.split("@")[0] ?? addr;
    return local;
  });
  return labels.join(", ");
}

// ─── Index build ──────────────────────────────────────────────────────────────

export interface BuildIndexOptions {
  /** Max number of messages to scan when building the index. Default: 5000 */
  messageLimit?: number;
  /** Only scan messages newer than this epoch ms. Default: 30 days ago */
  sinceMs?: number;
}

/**
 * Build (or refresh) the people-conversation index for a given account.
 *
 * This is a full rebuild: it clears existing rows for the account and
 * re-derives them from the messages table.  Designed to complete quickly
 * enough for an on-demand trigger (< 1 s for ~5 k messages in practice).
 */
export async function buildPeopleConversationIndex(
  accountId: string,
  userEmail: string,
  opts: BuildIndexOptions = {},
): Promise<void> {
  if (!userEmail) {
    console.warn("[peopleConversations] Skipping index build: userEmail is empty");
    return;
  }
  const db = await getDb();
  const limit = opts.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
  const since = opts.sinceMs ?? Date.now() - THIRTY_DAYS_MS;
  const sinceSeconds = Math.floor(since / 1000);

  // Fetch messages — we need enough fields to derive participants
  type MsgRow = {
    id: string;
    from_address: string | null;
    from_name: string | null;
    to_addresses: string | null;
    cc_addresses: string | null;
    subject: string | null;
    date: number;
    is_read: number;
  };

  const messages = await db.select<MsgRow[]>(
    `SELECT id, from_address, from_name, to_addresses, cc_addresses, subject, date, is_read
     FROM messages
     WHERE account_id = $1 AND date >= $2
     ORDER BY date DESC
     LIMIT $3`,
    [accountId, sinceSeconds, limit],
  );

  // Map: participantsKey → aggregated data
  type ConvAccum = {
    lastMsgAt: number;
    unread: number;
    msgCount: number;
    displayNames: Map<string, string>;
    latestSubject: string | null;
    messageIds: { id: string; date: number }[];
  };
  const convMap = new Map<string, ConvAccum>();

  for (const msg of messages) {
    const key = buildParticipantsKey(
      msg.from_address,
      msg.to_addresses,
      msg.cc_addresses,
      userEmail,
    );

    let accum = convMap.get(key);
    if (!accum) {
      accum = {
        lastMsgAt: 0,
        unread: 0,
        msgCount: 0,
        displayNames: new Map(),
        latestSubject: null,
        messageIds: [],
      };
      convMap.set(key, accum);
    }

    // Collect display names from all participants for title building
    if (msg.from_address && msg.from_name) {
      accum.displayNames.set(msg.from_address.toLowerCase(), msg.from_name);
    }

    accum.msgCount++;
    if (msg.is_read === 0) accum.unread++;
    if (msg.date > accum.lastMsgAt) {
      accum.lastMsgAt = msg.date;
      accum.latestSubject = msg.subject;
    }
    accum.messageIds.push({ id: msg.id, date: msg.date });
  }

  // Persist: clear old index for this account, then insert fresh rows
  await db.execute(
    "DELETE FROM people_conversations WHERE account_id = $1",
    [accountId],
  );
  await db.execute(
    "DELETE FROM people_conversation_messages WHERE account_id = $1",
    [accountId],
  );

  for (const [key, accum] of convMap.entries()) {
    const convId = `${PEOPLE_CONV_ID_PREFIX}${accountId}:${key}`;
    const title = buildTitle(key, accum.displayNames);

    await db.execute(
      `INSERT OR REPLACE INTO people_conversations
         (id, account_id, participants_key, title, last_message_at, unread_count, message_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [convId, accountId, key, title, accum.lastMsgAt, accum.unread, accum.msgCount],
    );

    for (const { id: msgId, date } of accum.messageIds) {
      await db.execute(
        `INSERT OR IGNORE INTO people_conversation_messages
           (conversation_id, account_id, message_id, received_at)
         VALUES ($1, $2, $3, $4)`,
        [convId, accountId, msgId, date],
      );
    }
  }
}

// ─── List / pagination ────────────────────────────────────────────────────────

export interface GetPeopleConversationsOptions {
  limit?: number;
  offset?: number;
}

export async function getPeopleConversations(
  accountId: string,
  opts: GetPeopleConversationsOptions = {},
): Promise<PeopleConversation[]> {
  const db = await getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return db.select<PeopleConversation[]>(
    `SELECT * FROM people_conversations
     WHERE account_id = $1 AND is_trashed = 0 AND is_archived = 0
     ORDER BY last_message_at DESC
     LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
}

export async function getPeopleConversationById(
  accountId: string,
  conversationId: string,
): Promise<PeopleConversation | null> {
  const db = await getDb();
  const rows = await db.select<PeopleConversation[]>(
    "SELECT * FROM people_conversations WHERE account_id = $1 AND id = $2",
    [accountId, conversationId],
  );
  return rows[0] ?? null;
}

// ─── Messages for a conversation ──────────────────────────────────────────────

export interface GetConversationMessagesOptions {
  /** Page size. Default: 20 */
  limit?: number;
  /**
   * Cursor for older-page loading. Pass the `received_at` of the oldest
   * message on the previous page.
   */
  beforeDate?: number;
}

export async function getMessagesForPeopleConversation(
  accountId: string,
  conversationId: string,
  opts: GetConversationMessagesOptions = {},
): Promise<DbMessage[]> {
  const db = await getDb();
  const limit = opts.limit ?? 20;

  if (opts.beforeDate !== undefined) {
    return db.select<DbMessage[]>(
      `SELECT m.* FROM messages m
       INNER JOIN people_conversation_messages pcm
         ON pcm.account_id = m.account_id AND pcm.message_id = m.id
       WHERE pcm.account_id = $1 AND pcm.conversation_id = $2
         AND pcm.received_at < $3
       ORDER BY pcm.received_at DESC
       LIMIT $4`,
      [accountId, conversationId, opts.beforeDate, limit],
    );
  }

  return db.select<DbMessage[]>(
    `SELECT m.* FROM messages m
     INNER JOIN people_conversation_messages pcm
       ON pcm.account_id = m.account_id AND pcm.message_id = m.id
     WHERE pcm.account_id = $1 AND pcm.conversation_id = $2
     ORDER BY pcm.received_at DESC
     LIMIT $3`,
    [accountId, conversationId, limit],
  );
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function setPeopleConversationFavorite(
  accountId: string,
  conversationId: string,
  isFavorite: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE people_conversations SET is_favorite = $1 WHERE account_id = $2 AND id = $3",
    [isFavorite ? 1 : 0, accountId, conversationId],
  );
}

export async function setPeopleConversationArchived(
  accountId: string,
  conversationId: string,
  archived: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE people_conversations SET is_archived = $1 WHERE account_id = $2 AND id = $3",
    [archived ? 1 : 0, accountId, conversationId],
  );
}

export async function setPeopleConversationTrashed(
  accountId: string,
  conversationId: string,
  trashed: boolean,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE people_conversations SET is_trashed = $1 WHERE account_id = $2 AND id = $3",
    [trashed ? 1 : 0, accountId, conversationId],
  );
}

/**
 * Look up which people conversation a given message belongs to.
 * Used when a search result is clicked in people mode.
 */
export async function getPeopleConversationForMessage(
  accountId: string,
  messageId: string,
): Promise<PeopleConversation | null> {
  const db = await getDb();
  const rows = await db.select<PeopleConversation[]>(
    `SELECT pc.* FROM people_conversations pc
     INNER JOIN people_conversation_messages pcm
       ON pcm.account_id = pc.account_id AND pcm.conversation_id = pc.id
     WHERE pcm.account_id = $1 AND pcm.message_id = $2
     LIMIT 1`,
    [accountId, messageId],
  );
  return rows[0] ?? null;
}
