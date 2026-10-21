import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A safety net around each page.
 *
 * React stops rendering the whole tree when any component throws, so one bug in
 * the Safety page would blank Home, the sidebar, and the sign-out button along
 * with it. The boundary catches the throw, shows what happened, and keeps the
 * rest of the console reachable — a user who hit a bug can still open another
 * page and keep working.
 *
 * Reset on navigation uses the standard React idiom: pass `key={page}` at the
 * use site to force a fresh instance when the route changes, instead of
 * tracking the key here. The alternative would need `setState` from a lifecycle
 * hook, which React advises against for exactly this reason.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged for the terminal and the browser console — useful during
    // development, and for a user asked to screenshot their devtools.
    console.error("[eznas] page threw:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} onDismiss={() => this.setState({ error: null })} />;
  }
}

function ErrorFallback({ error, onDismiss }: { error: Error; onDismiss: () => void }) {
  const copy = () => {
    const text = `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`;
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const home = () => {
    window.location.hash = "#/home";
    onDismiss();
  };
  return (
    <div className="login-wrap">
      <div className="login" style={{ maxWidth: 520 }}>
        <h1>Something went wrong on this page</h1>
        <p>
          The console caught the error so the rest of it still works. Open another page from the menu, or send what is
          below to whoever maintains this install.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "var(--input-bg)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          {error.message || error.name}
        </pre>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={copy}>
            Copy details
          </button>
          <button type="button" className="btn" onClick={() => onDismiss()}>
            Try again
          </button>
          <button type="button" className="btn primary" onClick={home}>
            Go to Home
          </button>
        </div>
      </div>
    </div>
  );
}
