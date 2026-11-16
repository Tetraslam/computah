import { formatDate, readChanges } from "@/lib/changes";

/** The real changes made to this site through its own box, newest first, read from git at build time. */
export function Changes() {
  const changes = readChanges();
  if (!changes.length) {
    return (
      <div className="empty">
        <p>nothing here yet. the first change someone types into the box will show up here</p>
      </div>
    );
  }
  return (
    <ol className="changes">
      {changes.map((change) => (
        <li key={change.sha} className="change" data-undone={change.undone || undefined}>
          <span className="mark" aria-hidden="true" />
          <p className="request">{change.request}</p>
          <p className="meta">
            asked by <b>{change.by}</b>, {formatDate(change.date)}
            {change.undone ? ", undone since" : ""}. commit <code>{change.sha.slice(0, 7)}</code>
          </p>
        </li>
      ))}
    </ol>
  );
}
