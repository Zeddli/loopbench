import Link from "next/link";
export default function NotFound() {
  return (
    <main className="container">
      <section className="empty-state">
        <h1>Tree not found</h1>
        <p>This tree is not in the local run store.</p>
        <Link className="btn" href="/">
          Browse trees →
        </Link>
      </section>
    </main>
  );
}
