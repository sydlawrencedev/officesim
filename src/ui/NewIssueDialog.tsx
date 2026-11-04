import { useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

/*
 * The form for a new issue.
 *
 * On the Mac it opens an issue on one of the GitHub repos the agents work in. The plugin opens
 * Paperclip's own New Issue dialog instead, so this is only used where the host can make one.
 *
 * The repo list comes from the host: it knows which repos the agents are in.
 */

export type IssueRepo = {
  /** "owner/repo", as GitHub names it. */
  repo: string;
  /** Its short name, for the list. */
  name: string;
  /** How many issues it has open, so the busiest is easy to pick. */
  open: number;
};

/** What the host needs to make an issue. */
export type NewIssue = {
  repo: string;
  title: string;
  body: string;
  labels: string[];
};

export function NewIssueDialog({
  repos,
  onClose,
  onCreated,
}: {
  /** The repos an issue can be made in; empty when the host can't make one. */
  repos: IssueRepo[];
  onClose: () => void;
  /** Called with the new issue's identifier and its web page. */
  onCreated: (issue: { identifier: string; url: string | null }) => void;
}) {
  const createIssue = usePluginAction("create-issue");
  const [repo, setRepo] = useState(repos[0]?.repo ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // The escape key closes it
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!repo || !title.trim()) {
      setError("It needs a repo and a title.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = (await createIssue({
        repo,
        title: title.trim(),
        body,
        labels: labels.split(",").map((label) => label.trim()).filter(Boolean),
      })) as { identifier?: string; url?: string } | null;
      onCreated({ identifier: result?.identifier ?? `${repo}#?`, url: result?.url ?? null });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }

  if (!repos.length) {
    return (
      <div className="op-issue-backdrop" role="dialog" aria-modal="true" aria-label="New issue">
        <div className="op-issue-form">
          <p className="op-issue-empty">There are no repos to add an issue to yet. The office reads the repos the agents work in, so it fills up as they start.</p>
          <button type="button" className="op-button" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="op-issue-backdrop" role="dialog" aria-modal="true" aria-label="New issue">
      <form className="op-issue-form" onSubmit={submit}>
        <h2 className="op-issue-title">New issue</h2>

        <label className="op-issue-field">
          <span className="op-issue-label">Repo</span>
          <select className="op-issue-input" value={repo} onChange={(event) => setRepo(event.target.value)}>
            {repos.map((entry) => (
              <option key={entry.repo} value={entry.repo}>
                {entry.name} ({entry.open} open)
              </option>
            ))}
          </select>
        </label>

        <label className="op-issue-field">
          <span className="op-issue-label">Title</span>
          <input
            ref={titleRef}
            className="op-issue-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What's wrong, or what's wanted?"
          />
        </label>

        <label className="op-issue-field">
          <span className="op-issue-label">Description</span>
          <textarea
            className="op-issue-input op-issue-textarea"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            placeholder="More detail, if there's any"
          />
        </label>

        <label className="op-issue-field">
          <span className="op-issue-label">Labels</span>
          <input
            className="op-issue-input"
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            placeholder="Comma separated, e.g. bug, seo"
          />
        </label>

        {error ? <div className="op-issue-error">{error}</div> : null}

        <div className="op-issue-actions">
          <button type="button" className="op-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="op-button op-button-new" disabled={saving || !title.trim()}>
            {saving ? "Adding…" : "Add issue"}
          </button>
        </div>
      </form>
    </div>
  );
}
