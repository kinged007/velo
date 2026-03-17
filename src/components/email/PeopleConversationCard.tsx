import { memo } from "react";
import { useUIStore } from "@/stores/uiStore";
import { formatRelativeDate } from "@/utils/date";
import { Star } from "lucide-react";
import type { PeopleConversation } from "@/services/db/peopleConversations";

interface PeopleConversationCardProps {
  conversation: PeopleConversation;
  isSelected: boolean;
  latestSubject?: string | null;
  onClick: (conversation: PeopleConversation) => void;
}

export const PeopleConversationCard = memo(function PeopleConversationCard({
  conversation,
  isSelected,
  latestSubject,
  onClick,
}: PeopleConversationCardProps) {
  const emailDensity = useUIStore((s) => s.emailDensity);

  const isUnread = conversation.unread_count > 0;
  const initial = (conversation.title?.[0] ?? "?").toUpperCase();
  const timestamp = conversation.last_message_at
    ? formatRelativeDate(conversation.last_message_at * 1000)
    : "";

  const densityClass =
    emailDensity === "compact"
      ? "py-2"
      : emailDensity === "spacious"
        ? "py-4"
        : "py-3";

  return (
    <button
      onClick={() => onClick(conversation)}
      aria-label={`Conversation with ${conversation.title ?? "unknown"}`}
      className={[
        "w-full text-left px-4 flex items-start gap-3 transition-colors border-b border-border-secondary/50",
        densityClass,
        isSelected
          ? "bg-accent/10 border-l-2 border-l-accent"
          : "hover:bg-bg-hover border-l-2 border-l-transparent",
      ].join(" ")}
    >
      {/* Avatar */}
      <div
        className={[
          "w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-semibold mt-0.5",
          isSelected
            ? "bg-accent text-white"
            : "bg-accent/20 text-accent",
        ].join(" ")}
      >
        {initial}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Row 1: title + timestamp */}
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={[
              "text-sm truncate",
              isUnread
                ? "font-semibold text-text-primary"
                : "font-medium text-text-primary",
            ].join(" ")}
          >
            {conversation.title ?? conversation.participants_key}
          </span>
          <span className="text-xs text-text-tertiary flex-shrink-0">
            {timestamp}
          </span>
        </div>

        {/* Row 2: latest subject + unread badge */}
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-xs text-text-secondary truncate">
            {latestSubject ?? `${conversation.message_count} message${conversation.message_count !== 1 ? "s" : ""}`}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {conversation.is_favorite === 1 && (
              <Star className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500" />
            )}
            {isUnread && (
              <span className="min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full bg-accent text-white text-xs font-medium">
                {conversation.unread_count > 99 ? "99+" : conversation.unread_count}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
});
