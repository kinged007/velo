import { useEffect, useState, useRef, useCallback } from "react";
import { MessageItem } from "./MessageItem";
import {
  getMessagesForPeopleConversation,
  setPeopleConversationFavorite,
  setPeopleConversationArchived,
  setPeopleConversationTrashed,
  type PeopleConversation,
} from "@/services/db/peopleConversations";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useComposerStore } from "@/stores/composerStore";
import { getSetting } from "@/services/db/settings";
import { getAllowlistedSenders } from "@/services/db/imageAllowlist";
import { Archive, Trash2, Star, RefreshCw, ChevronUp } from "lucide-react";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { MessageSkeleton } from "@/components/ui/Skeleton";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { DbMessage } from "@/services/db/messages";

interface PeopleConversationViewProps {
  conversation: PeopleConversation;
  onConversationUpdated?: () => void;
}

function buildQuote(msg: DbMessage): string {
  const date = new Date(msg.date * 1000).toLocaleString();
  const from = msg.from_name
    ? `${escapeHtml(msg.from_name)} &lt;${escapeHtml(msg.from_address ?? "")}&gt;`
    : escapeHtml(msg.from_address ?? "Unknown");
  const body = msg.body_html
    ? sanitizeHtml(msg.body_html)
    : `<pre style="white-space:pre-wrap">${escapeHtml(msg.body_text ?? "")}</pre>`;
  return `<br/><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">
    <div style="color:#666;font-size:12px;margin-bottom:4px">On ${date}, ${from} wrote:</div>
    ${body}
  </blockquote>`;
}

/** Build the "To" recipient list for a reply or reply-all. */
function buildReplyToRecipients(msg: DbMessage, replyAll: boolean): string[] {
  const replyTo = msg.reply_to ?? msg.from_address;
  if (!replyAll) {
    return replyTo ? [replyTo] : [];
  }
  const all = new Set<string>();
  if (replyTo) all.add(replyTo);
  if (msg.to_addresses) {
    msg.to_addresses.split(",").forEach((a) => {
      const t = a.trim();
      if (t) all.add(t);
    });
  }
  return Array.from(all);
}

const PAGE_SIZE = 20;

export function PeopleConversationView({
  conversation,
  onConversationUpdated,
}: PeopleConversationViewProps) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const openComposer = useComposerStore((s) => s.openComposer);
  const defaultReplyMode = useUIStore((s) => s.defaultReplyMode);

  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [blockImages, setBlockImages] = useState<boolean | null>(null);
  const [allowlistedSenders, setAllowlistedSenders] = useState<Set<string>>(new Set());
  const [isFavorite, setIsFavorite] = useState(conversation.is_favorite === 1);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Preload settings
  useEffect(() => {
    getSetting("block_remote_images").then((val) => setBlockImages(val !== "false"));
  }, []);

  // Load initial messages (most recent PAGE_SIZE, newest-first from DB, then reverse for display)
  useEffect(() => {
    if (!activeAccountId) return;
    setLoading(true);
    setMessages([]);
    setHasMore(true);

    getMessagesForPeopleConversation(activeAccountId, conversation.id, { limit: PAGE_SIZE })
      .then((rows) => {
        // rows come back newest-first from the DB; reverse so oldest is at top
        setMessages([...rows].reverse());
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [activeAccountId, conversation.id]);

  // Sync favorite state when conversation prop changes
  useEffect(() => {
    setIsFavorite(conversation.is_favorite === 1);
  }, [conversation.is_favorite]);

  // Build allowlist once messages are loaded
  useEffect(() => {
    if (!activeAccountId || messages.length === 0) return;
    let cancelled = false;
    const senders = [...new Set(messages.flatMap((m) => (m.from_address ? [m.from_address] : [])))];
    getAllowlistedSenders(activeAccountId, senders).then((allowed) => {
      if (!cancelled) setAllowlistedSenders(allowed);
    });
    return () => { cancelled = true; };
  }, [activeAccountId, messages]);

  // Load older messages (scroll-up pagination)
  const loadOlderMessages = useCallback(async () => {
    if (!activeAccountId || loadingMore || !hasMore || messages.length === 0) return;
    const oldest = messages[0];
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const older = await getMessagesForPeopleConversation(activeAccountId, conversation.id, {
        limit: PAGE_SIZE,
        beforeDate: oldest.date,
      });
      if (older.length === 0) {
        setHasMore(false);
      } else {
        // Preserve scroll position
        const container = scrollRef.current;
        const prevScrollHeight = container?.scrollHeight ?? 0;
        setMessages((prev) => [...[...older].reverse(), ...prev]);
        setHasMore(older.length === PAGE_SIZE);
        if (container) {
          requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight - prevScrollHeight;
          });
        }
      }
    } catch (err) {
      console.error("Failed to load older messages:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [activeAccountId, conversation.id, hasMore, loadingMore, messages]);

  // Detect scroll-to-top to trigger older message loading
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (container.scrollTop < 100) {
      loadOlderMessages();
    }
  }, [loadOlderMessages]);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  const handleReply = useCallback(() => {
    if (!lastMessage) return;

    const isReplyAll = defaultReplyMode === "replyAll";
    const to = buildReplyToRecipients(lastMessage, isReplyAll);
    const cc: string[] = isReplyAll && lastMessage.cc_addresses
      ? lastMessage.cc_addresses.split(",").map((a) => a.trim())
      : [];

    openComposer({
      mode: isReplyAll ? "replyAll" : "reply",
      to,
      cc,
      subject: `Re: ${lastMessage.subject ?? ""}`,
      bodyHtml: buildQuote(lastMessage),
      threadId: lastMessage.thread_id,
      inReplyToMessageId: lastMessage.id,
    });
  }, [lastMessage, openComposer, defaultReplyMode]);

  const handleToggleFavorite = useCallback(async () => {
    if (!activeAccountId) return;
    const next = !isFavorite;
    setIsFavorite(next);
    try {
      await setPeopleConversationFavorite(activeAccountId, conversation.id, next);
      onConversationUpdated?.();
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
      setIsFavorite(!next);
    }
  }, [activeAccountId, conversation.id, isFavorite, onConversationUpdated]);

  const handleArchive = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      await setPeopleConversationArchived(activeAccountId, conversation.id, true);
      onConversationUpdated?.();
    } catch (err) {
      console.error("Failed to archive conversation:", err);
    }
  }, [activeAccountId, conversation.id, onConversationUpdated]);

  const handleTrash = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      await setPeopleConversationTrashed(activeAccountId, conversation.id, true);
      onConversationUpdated?.();
    } catch (err) {
      console.error("Failed to trash conversation:", err);
    }
  }, [activeAccountId, conversation.id, onConversationUpdated]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border-secondary/50 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-text-primary truncate">
            {conversation.title ?? conversation.participants_key}
          </h2>
          {lastMessage?.subject && (
            <p className="text-xs text-text-tertiary truncate">
              Latest: {lastMessage.subject}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleToggleFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            className="p-1.5 rounded-md hover:bg-bg-hover transition-colors"
          >
            <Star
              className={[
                "w-4 h-4",
                isFavorite ? "text-yellow-500 fill-yellow-500" : "text-text-tertiary",
              ].join(" ")}
            />
          </button>
          <button
            onClick={handleArchive}
            title="Archive conversation"
            className="p-1.5 rounded-md hover:bg-bg-hover transition-colors"
          >
            <Archive className="w-4 h-4 text-text-tertiary" />
          </button>
          <button
            onClick={handleTrash}
            title="Trash conversation"
            className="p-1.5 rounded-md hover:bg-bg-hover transition-colors"
          >
            <Trash2 className="w-4 h-4 text-text-tertiary" />
          </button>
          <button
            onClick={handleReply}
            title="Reply"
            className="px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
          >
            Reply
          </button>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-1"
      >
        {/* Load more indicator */}
        {hasMore && !loading && (
          <div className="flex justify-center py-2">
            <button
              onClick={loadOlderMessages}
              disabled={loadingMore}
              className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              {loadingMore ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
              {loadingMore ? "Loading…" : "Load older messages"}
            </button>
          </div>
        )}

        {loading && (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <MessageSkeleton key={i} />
            ))}
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm text-text-tertiary">
            No messages found.
          </div>
        )}

        {!loading &&
          messages.map((msg, idx) => (
            <ErrorBoundary key={msg.id}>
              <MessageItem
                message={msg}
                isLast={idx === messages.length - 1}
                blockImages={blockImages ?? true}
                senderAllowlisted={allowlistedSenders.has(msg.from_address ?? "")}
                accountId={activeAccountId ?? undefined}
                threadId={msg.thread_id}
              />
            </ErrorBoundary>
          ))}
      </div>
    </div>
  );
}
