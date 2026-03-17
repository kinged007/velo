import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

import { getDb } from "@/services/db/connection";
import { createMockDb } from "@/test/mocks";
import {
  parseAddresses,
  buildParticipantsKey,
  buildTitle,
  getPeopleConversationById,
  getPeopleConversations,
  setPeopleConversationFavorite,
  setPeopleConversationArchived,
  setPeopleConversationTrashed,
  getPeopleConversationForMessage,
  getMessagesForPeopleConversation,
} from "./peopleConversations";

const mockDb = createMockDb();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
});

// ─── parseAddresses ────────────────────────────────────────────────────────────

describe("parseAddresses", () => {
  it("returns empty Set for null", () => {
    expect(parseAddresses(null).size).toBe(0);
  });

  it("parses a bare email address", () => {
    const result = parseAddresses("alice@example.com");
    expect(result.has("alice@example.com")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("parses a display-name+angle-bracket address", () => {
    const result = parseAddresses("Alice Smith <alice@example.com>");
    expect(result.has("alice@example.com")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("parses multiple comma-separated addresses", () => {
    const result = parseAddresses("alice@example.com, bob@example.com, Carol <carol@example.com>");
    expect(result.has("alice@example.com")).toBe(true);
    expect(result.has("bob@example.com")).toBe(true);
    expect(result.has("carol@example.com")).toBe(true);
    expect(result.size).toBe(3);
  });

  it("normalises to lowercase", () => {
    const result = parseAddresses("Alice@Example.COM");
    expect(result.has("alice@example.com")).toBe(true);
  });

  it("ignores values without an @ sign", () => {
    const result = parseAddresses("not-an-email");
    expect(result.size).toBe(0);
  });
});

// ─── buildParticipantsKey ──────────────────────────────────────────────────────

describe("buildParticipantsKey", () => {
  it("removes the user's own email and sorts the rest", () => {
    const key = buildParticipantsKey(
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "alice@example.com",
    );
    expect(key).toBe("bob@example.com,carol@example.com");
  });

  it("returns only the sender when all others are the user", () => {
    // to and cc are user — fallback to sender (which is also user), so use user email
    const key = buildParticipantsKey(
      "alice@example.com",
      "alice@example.com",
      null,
      "alice@example.com",
    );
    // Deduplicated and user removed → empty → fall back to user email
    expect(key).toBe("alice@example.com");
  });

  it("produces a stable sorted key regardless of header order", () => {
    const key1 = buildParticipantsKey("bob@x.com", "alice@x.com", null, "me@x.com");
    const key2 = buildParticipantsKey("alice@x.com", "bob@x.com", null, "me@x.com");
    expect(key1).toBe(key2);
  });

  it("handles plus-addressing variants of user email", () => {
    // user is me+tag@example.com; should still be excluded
    const key = buildParticipantsKey(
      "me+tag@example.com",
      "other@example.com",
      null,
      "me@example.com",
    );
    expect(key).toBe("other@example.com");
  });

  it("deduplicates addresses that appear in both from and to", () => {
    const key = buildParticipantsKey(
      "bob@x.com",
      "bob@x.com, carol@x.com",
      null,
      "me@x.com",
    );
    expect(key).toBe("bob@x.com,carol@x.com");
  });
});

// ─── buildTitle ───────────────────────────────────────────────────────────────

describe("buildTitle", () => {
  it("uses display name when available", () => {
    const names = new Map([["alice@example.com", "Alice Smith"]]);
    const title = buildTitle("alice@example.com", names);
    expect(title).toBe("Alice Smith");
  });

  it("falls back to local-part of email", () => {
    const title = buildTitle("alice@example.com", new Map());
    expect(title).toBe("alice");
  });

  it("builds a comma-separated list for multiple participants", () => {
    const names = new Map([
      ["alice@example.com", "Alice"],
      ["bob@example.com", "Bob"],
    ]);
    const title = buildTitle("alice@example.com,bob@example.com", names);
    expect(title).toBe("Alice, Bob");
  });
});

// ─── DB service calls ─────────────────────────────────────────────────────────

describe("getPeopleConversations", () => {
  it("queries with correct SQL and default limit", async () => {
    mockDb.select.mockResolvedValueOnce([]);
    await getPeopleConversations("acc-1");
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM people_conversations"),
      ["acc-1", 50, 0],
    );
  });

  it("respects custom limit and offset", async () => {
    mockDb.select.mockResolvedValueOnce([]);
    await getPeopleConversations("acc-1", { limit: 10, offset: 20 });
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM people_conversations"),
      ["acc-1", 10, 20],
    );
  });
});

describe("getPeopleConversationById", () => {
  it("returns null when not found", async () => {
    mockDb.select.mockResolvedValueOnce([]);
    const result = await getPeopleConversationById("acc-1", "conv-1");
    expect(result).toBeNull();
  });

  it("returns the first row when found", async () => {
    const conv = { id: "conv-1", account_id: "acc-1", participants_key: "bob@x.com", title: "Bob", last_message_at: 1000, unread_count: 2, message_count: 5, is_archived: 0, is_trashed: 0, is_favorite: 0 };
    mockDb.select.mockResolvedValueOnce([conv]);
    const result = await getPeopleConversationById("acc-1", "conv-1");
    expect(result).toEqual(conv);
  });
});

describe("setPeopleConversationFavorite", () => {
  it("updates is_favorite to 1 when true", async () => {
    await setPeopleConversationFavorite("acc-1", "conv-1", true);
    expect(mockDb.execute).toHaveBeenCalledWith(
      "UPDATE people_conversations SET is_favorite = $1 WHERE account_id = $2 AND id = $3",
      [1, "acc-1", "conv-1"],
    );
  });

  it("updates is_favorite to 0 when false", async () => {
    await setPeopleConversationFavorite("acc-1", "conv-1", false);
    expect(mockDb.execute).toHaveBeenCalledWith(
      "UPDATE people_conversations SET is_favorite = $1 WHERE account_id = $2 AND id = $3",
      [0, "acc-1", "conv-1"],
    );
  });
});

describe("setPeopleConversationArchived", () => {
  it("sets is_archived correctly", async () => {
    await setPeopleConversationArchived("acc-1", "conv-1", true);
    expect(mockDb.execute).toHaveBeenCalledWith(
      "UPDATE people_conversations SET is_archived = $1 WHERE account_id = $2 AND id = $3",
      [1, "acc-1", "conv-1"],
    );
  });
});

describe("setPeopleConversationTrashed", () => {
  it("sets is_trashed correctly", async () => {
    await setPeopleConversationTrashed("acc-1", "conv-1", true);
    expect(mockDb.execute).toHaveBeenCalledWith(
      "UPDATE people_conversations SET is_trashed = $1 WHERE account_id = $2 AND id = $3",
      [1, "acc-1", "conv-1"],
    );
  });
});

describe("getPeopleConversationForMessage", () => {
  it("returns null when no conversation found", async () => {
    mockDb.select.mockResolvedValueOnce([]);
    const result = await getPeopleConversationForMessage("acc-1", "msg-1");
    expect(result).toBeNull();
  });

  it("returns the conversation when found", async () => {
    const conv = { id: "conv-1", account_id: "acc-1", participants_key: "x", title: null, last_message_at: 0, unread_count: 0, message_count: 1, is_archived: 0, is_trashed: 0, is_favorite: 0 };
    mockDb.select.mockResolvedValueOnce([conv]);
    const result = await getPeopleConversationForMessage("acc-1", "msg-1");
    expect(result).toEqual(conv);
  });
});

describe("getMessagesForPeopleConversation", () => {
  it("queries without beforeDate by default", async () => {
    mockDb.select.mockResolvedValueOnce([]);
    await getMessagesForPeopleConversation("acc-1", "conv-1");
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY pcm.received_at DESC"),
      ["acc-1", "conv-1", 20],
    );
  });

  it("queries with beforeDate for pagination", async () => {
    mockDb.select.mockResolvedValueOnce([]);
    await getMessagesForPeopleConversation("acc-1", "conv-1", { beforeDate: 9999 });
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.stringContaining("pcm.received_at < $3"),
      ["acc-1", "conv-1", 9999, 20],
    );
  });
});
