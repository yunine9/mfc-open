import { mrParticipantsMessage, type MrParticipantsResult } from "../../src/mrParticipants";

export function MrParticipantsNotice({ result }: {
  result?: MrParticipantsResult;
}) {
  if (!result || result.status === "failed") return null;
  return <div className="text-sm" role="status">
    <p className="m-0 text-muted-foreground">{mrParticipantsMessage(result)}</p>
  </div>;
}
