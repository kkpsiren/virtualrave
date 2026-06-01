"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="route-error">
          <div className="route-error__panel">
            <div className="route-error__tag">// SYSTEM ERROR</div>
            <h1>Virtual Rave lost signal.</h1>
            <p>{error.message || "The application failed to render."}</p>
            <button type="button" onClick={reset}>
              RECONNECT
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
