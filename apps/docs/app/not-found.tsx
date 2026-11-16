import Link from "next/link";

export default function NotFound() {
  return (
    <main className="desk">
      <article className="card">
        <header>
          <h1 className="card-title">no such card</h1>
          <p className="card-lede">this stack doesn't have a card at that address.</p>
          <hr className="rule" />
        </header>
        <div className="prose">
          <p>
            <Link href="/">go to the home card</Link>, or press <span className="kbd">/</span> to find something.
          </p>
        </div>
      </article>
    </main>
  );
}
