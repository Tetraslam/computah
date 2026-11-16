import Link from "next/link";

export default function NotFound() {
  return (
    <main className="desk">
      <article className="card">
        <header>
          <h1 className="card-title">no such card</h1>
          <p className="card-lede">there's no card at this address, maybe it got renamed</p>
          <hr className="rule" />
        </header>
        <div className="prose">
          <p>
            <Link href="/">go back to the home card</Link>, or press <span className="kbd">/</span> to look for what you wanted
          </p>
        </div>
      </article>
    </main>
  );
}
