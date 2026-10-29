"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="container">
      <section className="empty-state">
        <h1>The local records could not be read</h1>
        <p>Check the terminal for the error, then try again.</p>
        <button className="btn" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
