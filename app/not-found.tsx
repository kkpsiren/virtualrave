import Link from "next/link";

export default function NotFound() {
  return (
    <main className="route-error">
      <div className="route-error__panel">
        <div className="route-error__tag">// 404</div>
        <h1>Nothing here.</h1>
        <p>This route is not part of the archive.</p>
        <Link href="/">RETURN HOME</Link>
      </div>
    </main>
  );
}
