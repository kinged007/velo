import { useEffect, useState } from "react";
import { ThreadView } from "../email/ThreadView";
import { PeopleConversationView } from "../email/PeopleConversationView";
import { useThreadStore } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import { useSelectedThreadId } from "@/hooks/useRouteNavigation";
import {
  PEOPLE_CONV_ID_PREFIX,
  getPeopleConversationById,
  type PeopleConversation,
} from "@/services/db/peopleConversations";
import { EmptyState } from "../ui/EmptyState";
import { ReadingPaneIllustration } from "../ui/illustrations";

/** Detect people conversation IDs by their explicit prefix. */
function isPeopleConvId(id: string): boolean {
  return id.startsWith(PEOPLE_CONV_ID_PREFIX);
}

export function ReadingPane() {
  const selectedId = useSelectedThreadId();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const selectedThread = useThreadStore((s) =>
    selectedId && !isPeopleConvId(selectedId)
      ? (s.threadMap.get(selectedId) ?? null)
      : null,
  );
  const [peopleConv, setPeopleConv] = useState<PeopleConversation | null>(null);
  const [convKey, setConvKey] = useState(0);

  // Load people conversation when the selected ID looks like one
  useEffect(() => {
    if (!selectedId || !isPeopleConvId(selectedId) || !activeAccountId) {
      setPeopleConv(null);
      return;
    }
    let cancelled = false;
    getPeopleConversationById(activeAccountId, selectedId)
      .then((conv) => { if (!cancelled) setPeopleConv(conv); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [selectedId, activeAccountId]);

  // Nothing selected
  if (!selectedId) {
    return (
      <div className="flex-1 flex flex-col bg-bg-primary/50 glass-panel">
        <EmptyState illustration={ReadingPaneIllustration} title="Velo" subtitle="Select an email to read" />
      </div>
    );
  }

  // People conversation selected
  if (isPeopleConvId(selectedId) && peopleConv) {
    return (
      <div className="flex-1 bg-bg-primary/50 overflow-hidden glass-panel">
        <PeopleConversationView
          key={`${peopleConv.id}-${convKey}`}
          conversation={peopleConv}
          onConversationUpdated={() => setConvKey((k) => k + 1)}
        />
      </div>
    );
  }

  // Thread selected (default mode)
  if (selectedThread) {
    return (
      <div className="flex-1 bg-bg-primary/50 overflow-hidden glass-panel">
        <ThreadView thread={selectedThread} />
      </div>
    );
  }

  // Loading / not found state
  return (
    <div className="flex-1 flex flex-col bg-bg-primary/50 glass-panel">
      <EmptyState illustration={ReadingPaneIllustration} title="Velo" subtitle="Select an email to read" />
    </div>
  );
}
