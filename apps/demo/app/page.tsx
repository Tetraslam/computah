import { Counter } from "./counter";

const ideas = ["make the title bigger", "turn the counter into a stopwatch", "add a field where i can leave myself a note"];

export default function Home() {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 pt-[9vh] pb-72">
      <article className="card w-full max-w-[560px] bg-paper px-9 pt-8 pb-7">
        <h1 className="text-center text-[44px] leading-none tracking-tight">computah</h1>
        <p className="mt-3 text-center text-[15px] italic">a card you can change by asking</p>
        <hr className="rule mt-6" />

        <p className="mt-5 text-[16px] leading-snug">
          Everything on this card is ordinary code in <span className="font-ui text-[13px] font-bold">apps/demo</span>. The small window below is the
          improvements box. Say what should be different, and an agent on your machine changes the code while you watch.
        </p>

        <h2 className="mt-6 font-ui text-[13px] font-bold">Something to change</h2>
        <div className="mt-3">
          <Counter />
        </div>

        <h2 className="mt-6 font-ui text-[13px] font-bold">Things to ask for</h2>
        <ul className="mt-2 text-[15px] leading-relaxed">
          {ideas.map((idea) => (
            <li key={idea} className="before:mr-2 before:content-['•']">
              {idea}
            </li>
          ))}
        </ul>
      </article>
    </main>
  );
}
