/**
 * 1-bit icons drawn from rows of pixels, so every edge is crisp and nothing is antialiased
 * into gray. "#" is ink. They take the current color, so an inverted button inverts them too.
 */
function Bitmap({ rows, label }: { rows: string[]; label?: string }) {
  const width = Math.max(...rows.map((row) => row.length));
  let path = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== "#") continue;
      let run = 1;
      while (row[x + run] === "#") run++;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return (
    <svg
      className="bitmap"
      width={width}
      height={rows.length}
      viewBox={`0 0 ${width} ${rows.length}`}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

const NEXT = [
  "#......",
  "##.....",
  "#.#....",
  "#..#...",
  "#...#..",
  "#....#.",
  "#.....#",
  "#....#.",
  "#...#..",
  "#..#...",
  "#.#....",
  "##.....",
  "#......",
];

const PREVIOUS = NEXT.map((row) => [...row].reverse().join(""));

const HOME = [
  "......#......",
  ".....#.#.....",
  "....#...#....",
  "...#.....#...",
  "..#.......#..",
  ".#.........#.",
  "#############",
  ".#.........#.",
  ".#.###.....#.",
  ".#.#.#..##.#.",
  ".#.#.#..##.#.",
  ".#.#.#.....#.",
  ".###########.",
];

/** Two cards, one behind the other: a stack. */
const STACK = [
  "...##########",
  "...#........#",
  "#########...#",
  "#.......#...#",
  "#.......#...#",
  "#.......#...#",
  "#.......#####",
  "#.......#....",
  "#########....",
];

export const NextIcon = () => <Bitmap rows={NEXT} />;
export const PreviousIcon = () => <Bitmap rows={PREVIOUS} />;
export const HomeIcon = () => <Bitmap rows={HOME} />;
export const StackIcon = () => <Bitmap rows={STACK} />;
