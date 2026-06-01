"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="route-error">
      <div className="route-error__panel">
        <div className="route-error__tag">// SIGNAL LOST</div>
        <h1>Something broke on the floor.</h1>
        <p>{error.message || "The page failed to render."}</p>
        <button type="button" onClick={reset}>
          TRY AGAIN
        </button>
      </div>
    </main>
  );
}
