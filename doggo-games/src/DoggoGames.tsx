import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DoggoGames – két miniapp egyben (mobilra optimalizálva):
 * 1) Memory párosító (nehézségi fok, időmérő, újra)
 * 2) Kirakó (3×3 / 4×4 / 5×5), ghost előnézet, ÉRINTÉS-BARÁT csere:
 *    - Húzd az ujjad a mezők fölött (nem kell hosszan nyomni),
 *    - vagy: koppintás + koppintás két mezőre a cseréhez.
 *
 * Használat:
 * - Add át a kutyás képeket props-ban, pl. <DoggoGames initialPhotos={["/photos/dog1.jpg", "/photos/dog2.jpg"]} />
 *   VAGY a felületen tölts fel képeket (több is mehet egyszerre).
 *
 * UI változtatások mobilra:
 * - Rugalmas fejléckiosztás (stack mobilon),
 * - Navigáció gombok teljes szélességben, nem lógnak ki,
 * - Vezérlők kisebb paddinggel, wrap-olnak,
 * - Kirakó: saját pointer-alapú drag (touch-on AZONNAL működik),
 *           + koppintásos csere fallback.
 */

// GH Pages projektútvonal (repo neve). Dev módban marad "/".
// Minden maci*.jpg automatikus betöltése buildben is, helyes base-szel
// A fájlhoz (DoggoGames.tsx) képest relatív utakból csinál buildelt URL-t
const DEFAULT_PHOTOS = Array.from(
  { length: 16 },
  (_, i) => new URL(`./assets/maci${i + 1}.jpg`, import.meta.url).href
);

// -------------------- UTIL --------------------

type DifficultyKey = "easy" | "medium" | "hard";
const DIFFICULTIES: Record<
  DifficultyKey,
  { pairs: number; cols: number; label: string }
> = {
  easy: { pairs: 6, cols: 4, label: "Könnyű (6 pár)" }, // 3×4
  medium: { pairs: 8, cols: 4, label: "Közepes (8 pár)" }, // 4×4
  hard: { pairs: 10, cols: 5, label: "Nehéz (10 pár)" }, // 5×4
};

function msToClock(ms: number) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function useStopwatch(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    let raf: number | null = null;
    const tick = (t: number) => {
      if (startRef.current == null) startRef.current = t;
      setElapsed(t - startRef.current);
      if (running) raf = requestAnimationFrame(tick);
    };

    if (running) {
      startRef.current = null;
      raf = requestAnimationFrame(tick);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [running]);

  return { elapsed, reset: () => setElapsed(0) };
}

// -------------------- MEMORY GAME --------------------

type Card = {
  id: number; // pár-azonosító
  img: string; // kép URL
  index: number; // pozíció a pakliban
  flipped: boolean;
  matched: boolean;
};

function createMemoryDeck(allPhotos: string[], pairs: number): Card[] {
  // Válasszunk 'pairs' darab egyedi fotót (ha kevés a kép, körbeérünk)
  const unique: string[] = [];
  for (let i = 0; i < pairs; i++) {
    unique.push(allPhotos[i % allPhotos.length]);
  }
  const cards: Card[] = unique.flatMap((img, pairIdx) => [
    { id: pairIdx, img, index: -1, flipped: false, matched: false },
    { id: pairIdx, img, index: -1, flipped: false, matched: false },
  ]);
  // Fisher–Yates keverés és indexelés
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  cards.forEach((c, i) => (c.index = i));
  return cards;
}

function MemoryGame({ photos }: { photos: string[] }) {
  const [difficulty, setDifficulty] = useState<DifficultyKey>("medium");
  const [deck, setDeck] = useState<Card[]>([]);
  const [flipped, setFlipped] = useState<number[]>([]); // indexek
  const [hasStarted, setHasStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [moves, setMoves] = useState(0);

  // --- LOCK + TIMEOUT KEZELÉS (stabilabb tappinghez) ---
  const [locked, setLockedState] = useState(false);
  const lockedRef = useRef(false);
  const setLocked = (v: boolean) => {
    lockedRef.current = v;
    setLockedState(v);
  };
  const timeoutsRef = useRef<number[]>([]);
  const addTimer = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timeoutsRef.current.push(id);
  };
  const clearTimers = () => {
    timeoutsRef.current.forEach((id) => clearTimeout(id));
    timeoutsRef.current = [];
  };
  useEffect(() => () => clearTimers(), []);

  const { elapsed, reset } = useStopwatch(hasStarted && !finished);
  const bestKey = `doggo_mem_best_${difficulty}`;
  const bestMs =
    typeof window !== "undefined"
      ? Number(localStorage.getItem(bestKey) || 0)
      : 0;

  const cols = DIFFICULTIES[difficulty].cols;

  const startNew = (d: DifficultyKey = difficulty) => {
    clearTimers();
    setLocked(false);

    const pairs = DIFFICULTIES[d].pairs;
    const src = photos.length ? photos : DEFAULT_PHOTOS;
    const safe = src.length
      ? src
      : [
          // fallback placeholder (SVG data URL)
          "data:image/svg+xml;utf8," +
            encodeURIComponent(
              `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"800\" height=\"600\" viewBox=\"0 0 800 600\"><rect width=\"100%\" height=\"100%\" fill=\"#f1f5f9\"/><text x=\"50%\" y=\"50%\" dominant-baseline=\"middle\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"28\" fill=\"#64748b\">Tölts fel képeket a Starthoz 🐾</text></svg>`
            ),
        ];
    const newDeck = createMemoryDeck(safe, pairs);
    setDeck(newDeck);
    setFlipped([]);
    setHasStarted(false);
    setFinished(false);
    setMoves(0);
    reset();
  };

  useEffect(() => {
    startNew(difficulty); /* eslint-disable-next-line */
  }, [difficulty, photos.join("|")]);

  useEffect(() => {
    if (!deck.length) return;
    const allMatched = deck.every((c) => c.matched);
    if (allMatched && deck.length) {
      setFinished(true);
      // best time mentése
      if (!bestMs || elapsed < bestMs) {
        localStorage.setItem(bestKey, String(elapsed));
      }
    }
  }, [deck, elapsed, bestMs, bestKey]);

  const onCardClick = (idx: number) => {
    if (finished) return;
    if (lockedRef.current) return; // zárolva az ellenőrzés alatt
    if (flipped.length >= 2) return;

    const card = deck[idx];
    if (card.matched || card.flipped) return;

    if (!hasStarted) setHasStarted(true);

    const newDeck = deck.slice();
    newDeck[idx] = { ...card, flipped: true };
    const newFlipped = [...flipped, idx];

    setDeck(newDeck);
    setFlipped(newFlipped);

    if (newFlipped.length === 2) {
      setMoves((m) => m + 1);
      setLocked(true);

      const [a, b] = newFlipped;
      const ca = newDeck[a];
      const cb = newDeck[b];

      if (ca.id === cb.id) {
        // találat
        addTimer(() => {
          setDeck((d) => {
            const dd = d.slice();
            dd[a] = { ...dd[a], matched: true };
            dd[b] = { ...dd[b], matched: true };
            return dd;
          });
          setFlipped([]);
          setLocked(false);
        }, 200);
      } else {
        // nem találat -> visszafordítás
        addTimer(() => {
          setDeck((d) => {
            const dd = d.slice();
            dd[a] = { ...dd[a], flipped: false };
            dd[b] = { ...dd[b], flipped: false };
            return dd;
          });
          setFlipped([]);
          setLocked(false);
        }, 600);
      }
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <select
            className="px-3 py-2 rounded-xl bg-white shadow border border-slate-200 w-full sm:w-auto"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as DifficultyKey)}
          >
            {Object.entries(DIFFICULTIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => startNew()}
            className="px-4 py-2 rounded-xl bg-slate-900 text-white shadow hover:opacity-90 w-full sm:w-auto"
          >
            Újrakeverés
          </button>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="text-slate-600">
            Lépések:{" "}
            <span className="font-semibold text-slate-900">{moves}</span>
          </div>
          <div className="text-slate-600">
            Idő:{" "}
            <span className="font-mono text-slate-900">
              {msToClock(elapsed)}
            </span>
          </div>
          {bestMs > 0 && (
            <div className="text-xs text-emerald-700 bg-emerald-50 px-2 py-1 rounded-lg">
              Legjobb: {msToClock(bestMs)}
            </div>
          )}
        </div>
      </div>

      <div
        className="grid gap-2 sm:gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {deck.map((card, i) => (
          <button
            key={i}
            onClick={() => onCardClick(i)}
            disabled={locked}
            aria-disabled={locked}
            className={`relative aspect-[3/4] rounded-2xl overflow-hidden shadow transition-transform active:scale-[0.98] ${
              card.matched ? "ring-2 ring-emerald-500" : ""
            } ${locked ? "cursor-not-allowed" : ""}`}
            aria-label={
              card.flipped || card.matched
                ? "kártya (nyitva)"
                : "kártya (zárva)"
            }
          >
            {/* face */}
            <div
              className={`absolute inset-0 bg-slate-100 flex items-center justify-center text-3xl sm:text-4xl select-none ${
                card.flipped || card.matched ? "opacity-0" : "opacity-100"
              }`}
            >
              <span className="opacity-60">🐾</span>
            </div>
            {/* photo */}
            <div
              className={`absolute inset-0 transition-opacity duration-300 ${
                card.flipped || card.matched ? "opacity-100" : "opacity-0"
              }`}
            >
              <div
                className="w-full h-full bg-center bg-cover"
                style={{ backgroundImage: `url(${card.img})` }}
              />
            </div>
          </button>
        ))}
      </div>

      {finished && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-sm">
          Kész! 🎉 Időd: <span className="font-mono">{msToClock(elapsed)}</span>{" "}
          — Lépések: {moves}
        </div>
      )}
    </div>
  );
}

// -------------------- JIGSAW PUZZLE (mobilbarát pointer + tap) --------------------

type Tile = {
  id: number; // helyes index (0..n-1)
  order: number; // aktuális hely (0..n-1)
  bgPos: string; // CSS backgroundPosition
};

function makeTiles(img: string, grid: number): Tile[] {
  const total = grid * grid;
  const step = 100 / (grid - 1);
  const tiles: Tile[] = [];
  for (let i = 0; i < total; i++) {
    const row = Math.floor(i / grid);
    const col = i % grid;
    const pos = `${col * step}% ${row * step}%`;
    tiles.push({ id: i, order: i, bgPos: pos });
  }
  return tiles;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isSolved(tiles: Tile[]) {
  return tiles.every((t) => t.id === t.order);
}

function JigsawPuzzle({ photos }: { photos: string[] }) {
  const [grid, setGrid] = useState(3); // 3,4,5
  const [img, setImg] = useState<string>(photos[0] || "");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [showGhost, setShowGhost] = useState(true);

  // ÚJ: érintés-barát csere: pointer követés + tap-to-swap
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<{
    active: boolean;
    fromOrder: number | null;
    hoverOrder: number | null;
    didMove: boolean;
  }>({ active: false, fromOrder: null, hoverOrder: null, didMove: false });
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);

  const startNew = (newImg = img, newGrid = grid) => {
    const base = newImg || photos[0] || DEFAULT_PHOTOS[0] || "";
    const t = makeTiles(base, newGrid);
    const shuffledOrders = shuffle(t.map((x) => x.order));
    if (shuffledOrders.every((o, i) => o === i)) shuffledOrders.reverse();
    const mixed = t.map((tile, i) => ({ ...tile, order: shuffledOrders[i] }));
    setTiles(mixed);
    setSelectedOrder(null);
  };

  useEffect(() => {
    startNew(); /* eslint-disable-next-line */
  }, [img, grid]);

  const byOrder = useMemo(() => {
    const m = new Map<number, Tile>();
    tiles.forEach((t) => m.set(t.order, t));
    return m;
  }, [tiles]);

  const onSwap = (fromOrder: number, toOrder: number) => {
    if (fromOrder === toOrder) return;
    setTiles((prev) =>
      prev.map((t) => {
        if (t.order === fromOrder) return { ...t, order: toOrder };
        if (t.order === toOrder) return { ...t, order: fromOrder };
        return t;
      })
    );
  };

  // --- Pointer alapú húzás (működik azonnal touch-on) ---
  const computeOrderFromPoint = (clientX: number, clientY: number) => {
    const root = gridRef.current;
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const cw = r.width / grid;
    const ch = r.height / grid;
    const x = Math.min(Math.max(clientX - r.left, 0), r.width - 0.01);
    const y = Math.min(Math.max(clientY - r.top, 0), r.height - 0.01);
    const col = Math.floor(x / cw);
    const row = Math.floor(y / ch);
    return row * grid + col;
  };

  const handlePointerDown = (order: number) => (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging({
      active: true,
      fromOrder: order,
      hoverOrder: order,
      didMove: false,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.active) return;
    const ord = computeOrderFromPoint(e.clientX, e.clientY);
    setDragging((d) => ({ ...d, didMove: true, hoverOrder: ord }));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragging.active) return;
    const targetOrder = dragging.hoverOrder ?? dragging.fromOrder!;
    const fromOrder = dragging.fromOrder!;
    if (dragging.didMove && targetOrder != null && fromOrder != null) {
      onSwap(fromOrder, targetOrder);
      setSelectedOrder(null);
    } else {
      // Nem mozdult: koppintás logika (tap-to-swap)
      if (selectedOrder == null) setSelectedOrder(fromOrder);
      else if (selectedOrder === fromOrder) setSelectedOrder(null);
      else {
        onSwap(selectedOrder, fromOrder);
        setSelectedOrder(null);
      }
    }
    setDragging({
      active: false,
      fromOrder: null,
      hoverOrder: null,
      didMove: false,
    });
  };

  const solved = isSolved(tiles);

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <select
            className="px-3 py-2 rounded-xl bg-white shadow border border-slate-200 w-full sm:w-auto"
            value={grid}
            onChange={(e) => setGrid(Number(e.target.value))}
          >
            <option value={3}>3×3</option>
            <option value={4}>4×4</option>
            <option value={5}>5×5</option>
          </select>
          <button
            onClick={() => startNew()}
            className="px-4 py-2 rounded-xl bg-slate-900 text-white shadow hover:opacity-90 w-full sm:w-auto"
          >
            Újrakeverés
          </button>
          <label className="flex items-center gap-2 text-sm px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 w-full sm:w-auto">
            <input
              type="checkbox"
              checked={showGhost}
              onChange={(e) => setShowGhost(e.target.checked)}
            />
            Ghost előnézet
          </label>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <select
            className="px-3 py-2 rounded-xl bg-white shadow border border-slate-200 w-full sm:max-w-xs"
            value={img}
            onChange={(e) => setImg(e.target.value)}
          >
            {photos.length === 0 && (
              <option value="">(Tölts fel legalább 1 képet)</option>
            )}
            {photos.map((p, i) => (
              <option key={i} value={p}>{`Kép ${i + 1}`}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Játékmező */}
      <div className="relative" onPointerMove={handlePointerMove}>
        {/* ghost háttér */}
        {showGhost && img && (
          <div className="absolute inset-0 rounded-2xl overflow-hidden opacity-25 pointer-events-none">
            <div
              className="w-full h-full bg-center bg-cover"
              style={{ backgroundImage: `url(${img})` }}
            />
          </div>
        )}

        <div
          ref={gridRef}
          className="grid gap-1 rounded-2xl overflow-hidden border border-slate-200 shadow relative touch-none select-none"
          style={{ gridTemplateColumns: `repeat(${grid}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: grid * grid }).map((_, order) => {
            const tile = byOrder.get(order)!;
            const isSelected = selectedOrder === order;
            const isHover = dragging.active && dragging.hoverOrder === order;
            return (
              <div
                key={order}
                className={`aspect-square bg-slate-100 relative ${
                  solved ? "ring-2 ring-emerald-500" : ""
                } ${isHover ? "ring-2 ring-sky-400" : ""} ${
                  isSelected ? "ring-2 ring-amber-400" : ""
                }`}
                // Kattintás (fallback): két koppintásos csere
                onClick={() => {
                  if (dragging.active) return; // drag közben ne katt
                  if (selectedOrder == null) setSelectedOrder(order);
                  else if (selectedOrder === order) setSelectedOrder(null);
                  else {
                    onSwap(selectedOrder, order);
                    setSelectedOrder(null);
                  }
                }}
              >
                {tile && (
                  <div
                    onPointerDown={handlePointerDown(order)}
                    onPointerUp={handlePointerUp}
                    className={`absolute inset-0 cursor-pointer active:cursor-grabbing transition-transform ${
                      dragging.active && dragging.fromOrder === order
                        ? "scale-[0.98]"
                        : ""
                    }`}
                    style={{
                      backgroundImage: `url(${img})`,
                      backgroundSize: `${grid * 100}% ${grid * 100}%`,
                      backgroundPosition: tile.bgPos,
                    }}
                    aria-label={`mozaik darab #${tile.id}`}
                    title="Húzd az ujjad a célmező fölé vagy koppints két mezőre a cseréhez"
                  />
                )}
              </div>
            );
          })}
        </div>

        {solved && (
          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900 text-sm">
            Kirakva! 🎉
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------- FOTÓK KEZELÉSE + SHELL --------------------

function useObjectUrls(files: File[]) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = files.map((f) => URL.createObjectURL(f));
    setUrls(u);
    return () => {
      u.forEach(URL.revokeObjectURL);
    };
  }, [files]);
  return urls;
}

function PhotoLoader({ onAdd }: { onAdd: (urls: string[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);

  useEffect(() => {
    if (urls.length) onAdd(urls); /* eslint-disable-next-line */
  }, [urls.join("|")]);

  return (
    <label className="inline-flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2 rounded-xl bg-white shadow border border-slate-200 cursor-pointer hover:bg-slate-50 text-sm">
      <input
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => setFiles(Array.from(e.target.files || []))}
      />
      <span>📸 Képek hozzáadása</span>
    </label>
  );
}

export default function DoggoGames({
  initialPhotos = DEFAULT_PHOTOS,
}: {
  initialPhotos?: string[];
}) {
  const [photos, setPhotos] = useState<string[]>(initialPhotos);
  const addPhotos = (urls: string[]) =>
    setPhotos((prev) => Array.from(new Set([...prev, ...urls])));

  const [tab, setTab] = useState<"memory" | "puzzle">("memory");

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900">
      <div className="max-w-6xl mx-auto p-3 sm:p-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
          <h1 className="text-xl sm:text-3xl font-bold tracking-tight">
            🐶 Doggo Games
          </h1>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
            <PhotoLoader onAdd={addPhotos} />
            <nav className="flex items-center bg-white rounded-xl shadow border border-slate-200 overflow-hidden w-full sm:w-auto">
              <button
                onClick={() => setTab("memory")}
                className={`px-4 py-2 text-sm flex-1 sm:flex-none ${
                  tab === "memory"
                    ? "bg-slate-900 text-amber-300"
                    : "hover:bg-slate-50"
                }`}
              >
                Memory
              </button>
              <button
                onClick={() => setTab("puzzle")}
                className={`px-4 py-2 text-sm flex-1 sm:flex-none ${
                  tab === "puzzle"
                    ? "bg-slate-900 text-amber-300"
                    : "hover:bg-slate-50"
                }`}
              >
                Kirakó
              </button>
            </nav>
          </div>
        </header>

        {/* Info doboz, ha nincsenek képek */}
        {photos.length === 0 && (
          <div className="mb-6 p-4 bg-white border border-slate-200 rounded-xl shadow text-sm">
            Nincs még kép hozzáadva. Katt a{" "}
            <span className="font-medium">“Képek hozzáadása”</span> gombra és
            válassz ki néhány kedvenc kutyás fotót! 😊
          </div>
        )}

        {tab === "memory" ? (
          <MemoryGame photos={photos} />
        ) : (
          <JigsawPuzzle photos={photos} />
        )}

        <footer className="mt-8 text-xs text-slate-500">
          Tipp: a legjobb élményhez mobilon is próbáld ki; a Memory játék menti
          a legjobb időt nehézség szerint.
        </footer>
      </div>
    </div>
  );
}
