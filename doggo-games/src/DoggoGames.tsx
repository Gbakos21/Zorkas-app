import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DoggoGames – két miniapp egyben (mobil + szint rendszer a kirakóhoz):
 * 1) Memory párosító (nehézségi fok, időmérő, újra) + SFX
 * 2) Kirakó szintekkel (3×3 / 4×4 / 5×5), ghost előnézet, ÉRINTÉS-BARÁT csere,
 *    SFX és 🎉🐶 konfetti a szint befejezésénél.
 *
 * ÚJ: Felhasználói képek tartósítása
 * - A feltöltött képeket Data URL-ként elmentjük localStorage-be
 * - Betöltéskor automatikusan hozzáadjuk az alap képekhez
 * - (Alap tömörítés: max 1400px oldal, hogy beleférjen a localStorage-be)
 */

// GH Pages projektútvonal (repo neve). Dev módban marad "/".
const DEFAULT_PHOTOS = Array.from(
  { length: 16 },
  (_, i) => new URL(`./assets/maci${i + 1}.jpg`, import.meta.url).href
);

const LS_USER_PHOTOS_KEY = "doggo_user_photos_v1";
const LS_SFX_KEY = "doggo_sfx_enabled_v1";
const LS_GHOST_KEY = "doggo_puzzle_ghost_v1"; // <-- Ghost beállítás mentése

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
      setElapsed(t - startRef.current!);
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

// ----- SFX (WebAudio) -----
type Sfx = { flip: () => void; match: () => void; win: () => void };

function useSfx(enabled: boolean): Sfx {
  const ctxRef = useRef<AudioContext | null>(null);

  const ensure = () => {
    if (!enabled) return null;
    // @ts-ignore
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctxRef.current) ctxRef.current = new AC();
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume().catch(() => {});
    }
    return ctxRef.current;
  };

  const ping = (
    freq: number,
    duration = 0.07,
    type: OscillatorType = "sine",
    vol = 0.03,
    whenOffset = 0
  ) => {
    if (!enabled) return;
    const ctx = ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + whenOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration);
  };

  const flip = () => {
    ping(420, 0.05, "triangle", 0.03);
  };
  const match = () => {
    ping(620, 0.06, "square", 0.035, 0);
    ping(740, 0.08, "square", 0.03, 0.08);
  };
  const win = () => {
    ping(660, 0.09, "sine", 0.04, 0);
    ping(880, 0.1, "sine", 0.04, 0.12);
    ping(990, 0.12, "sine", 0.04, 0.26);
  };

  return { flip, match, win };
}

// DataURL <-> localStorage helpers
function loadUserPhotos(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_USER_PHOTOS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}
function saveUserPhotos(urls: string[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_USER_PHOTOS_KEY, JSON.stringify(urls));
}

// Kép → DataURL (max méret skálázás, JPEG 0.9)
async function fileToDataUrl(file: File, maxSide = 1400): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });

  const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });

  const { width, height } = imgEl;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (scale >= 1) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

// -------------------- MEMORY GAME --------------------

type Card = {
  id: number;
  img: string;
  index: number;
  flipped: boolean;
  matched: boolean;
};

function createMemoryDeck(allPhotos: string[], pairs: number): Card[] {
  const unique: string[] = [];
  for (let i = 0; i < pairs; i++) unique.push(allPhotos[i % allPhotos.length]);
  const cards: Card[] = unique.flatMap((img, pairIdx) => [
    { id: pairIdx, img, index: -1, flipped: false, matched: false },
    { id: pairIdx, img, index: -1, flipped: false, matched: false },
  ]);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  cards.forEach((c, i) => (c.index = i));
  return cards;
}

function MemoryGame({ photos, sfx }: { photos: string[]; sfx: Sfx }) {
  const [difficulty, setDifficulty] = useState<DifficultyKey>("medium");
  const [deck, setDeck] = useState<Card[]>([]);
  const [flipped, setFlipped] = useState<number[]>([]);
  const [hasStarted, setHasStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [moves, setMoves] = useState(0);

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
          "data:image/svg+xml;utf8," +
            encodeURIComponent(
              `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#64748b">Tölts fel képeket a Starthoz 🐾</text></svg>`
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
    if (allMatched) {
      setFinished(true);
      sfx.win(); // SFX: győzelem
      if (!bestMs || elapsed < bestMs)
        localStorage.setItem(bestKey, String(elapsed));
    }
  }, [deck, elapsed, bestMs, bestKey]);

  const onCardClick = (idx: number) => {
    if (finished || lockedRef.current) return;
    if (flipped.length >= 2) return;
    const card = deck[idx];
    if (card.matched || card.flipped) return;

    sfx.flip(); // SFX: flip
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
        addTimer(() => {
          sfx.match(); // SFX: pár
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
            className="px-4 py-2 rounded-xl bg-slate-900 text-amber-300 shadow hover:opacity-90 w-full sm:w-auto"
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
            <div
              className={`absolute inset-0 bg-slate-100 flex items-center justify-center text-3xl sm:text-4xl select-none ${
                card.flipped || card.matched ? "opacity-0" : "opacity-100"
              }`}
            >
              <span className="opacity-60">🐶</span>
            </div>
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

// -------------------- JIGSAW PUZZLE (szintek + mobilbarát pointer + tap) --------------------

type Tile = { id: number; order: number; bgPos: string };

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

// üres tábla NEM kész
function isSolved(tiles: Tile[]) {
  return tiles.length > 0 && tiles.every((t) => t.id === t.order);
}

// Egyszerű hash a fotólista azonosításához (LocalStorage kulcshoz)
function hashPhotos(photos: string[]) {
  let h = 5381;
  for (const ch of photos.join("|")) h = (h * 33) ^ ch.charCodeAt(0);
  return (h >>> 0).toString(36);
}

type CampaignState = { index: number; solved: boolean[] };

function JigsawPuzzle({ photos, sfx }: { photos: string[]; sfx: Sfx }) {
  const [grid, setGrid] = useState(3); // 3,4,5

  // Kampány állapot betöltése/fenntartása a fotólistához kötve
  const photosHash = useMemo(() => hashPhotos(photos), [photos.join("|")]);
  const progKey = `doggo_puzzle_prog_${photosHash}`;
  const gridKey = `doggo_puzzle_last_grid`;

  const loadCampaign = (): CampaignState => {
    if (typeof window === "undefined")
      return { index: 0, solved: photos.map(() => false) };
    try {
      const raw = localStorage.getItem(progKey);
      if (!raw) return { index: 0, solved: photos.map(() => false) };
      const parsed = JSON.parse(raw) as CampaignState;
      const len = photos.length;
      const solved = Array.from(
        { length: len },
        (_, i) => parsed.solved?.[i] ?? false
      );
      const index = Math.min(Math.max(parsed.index ?? 0, 0), len - 1);
      return { index, solved };
    } catch {
      return { index: 0, solved: photos.map(() => false) };
    }
  };

  const [campaign, setCampaign] = useState<CampaignState>(() => loadCampaign());
  useEffect(() => {
    setCampaign(loadCampaign());
  }, [photosHash]);

  // Kampány állapot automatikus mentése minden változásnál
  useEffect(() => {
    try {
      localStorage.setItem(progKey, JSON.stringify(campaign));
    } catch {
      // betelt localStorage esetén csendben elnyeljük
    }
  }, [progKey, campaign]);

  useEffect(() => {
    if (typeof window !== "undefined")
      localStorage.setItem(gridKey, String(grid));
  }, [grid]);
  useEffect(() => {
    if (typeof window !== "undefined") {
      const g = Number(localStorage.getItem(gridKey));
      if (g === 3 || g === 4 || g === 5) setGrid(g);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aktuális kép mindig a kampány indexe
  const currentImg =
    photos[campaign.index] || photos[0] || DEFAULT_PHOTOS[0] || "";
  const [img, setImg] = useState<string>(currentImg);
  useEffect(() => setImg(currentImg), [currentImg]);

  const [tiles, setTiles] = useState<Tile[]>([]);
  // GHOST alapból OFF + mentett érték visszatöltése
  const [showGhost, setShowGhost] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const raw = localStorage.getItem(LS_GHOST_KEY);
    return raw === "true"; // ha nincs, false
  });
  // GHOST mentése
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_GHOST_KEY, String(showGhost));
    }
  }, [showGhost]);

  // Érintés-barát csere: pointer követés + tap-to-swap
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<{
    active: boolean;
    fromOrder: number | null;
    hoverOrder: number | null;
    didMove: boolean;
  }>({ active: false, fromOrder: null, hoverOrder: null, didMove: false });
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);

  const startNew = (newImg = img, newGrid = grid) => {
    const base = newImg || currentImg;
    const t = makeTiles(base, newGrid);
    const shuffledOrders = shuffle(t.map((x) => x.order));
    if (shuffledOrders.every((o, i) => o === i)) shuffledOrders.reverse();
    const mixed = t.map((tile, i) => ({ ...tile, order: shuffledOrders[i] }));
    setTiles(mixed);
    setSelectedOrder(null);
    prevSolvedRef.current = false;
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

  // Pointer alapú húzás
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
  const handlePointerUp = () => {
    if (!dragging.active) return;
    const targetOrder = dragging.hoverOrder ?? dragging.fromOrder!;
    const fromOrder = dragging.fromOrder!;
    if (dragging.didMove && targetOrder != null && fromOrder != null) {
      onSwap(fromOrder, targetOrder);
      sfx.flip(); // SFX: csere/húzás
      setSelectedOrder(null);
    } else {
      // tap-to-swap
      if (selectedOrder == null) setSelectedOrder(fromOrder);
      else if (selectedOrder === fromOrder) setSelectedOrder(null);
      else {
        onSwap(selectedOrder, fromOrder);
        sfx.flip(); // SFX: csere
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
  const prevSolvedRef = useRef(false);

  // Pop-up a befejezéshez
  const [showCongrats, setShowCongrats] = useState(false);
  const handleNextLevel = () => {
    setShowCongrats(false);
    if (campaign.index < photos.length - 1) {
      const nextIndex = campaign.index + 1;
      const updated: CampaignState = {
        index: nextIndex,
        solved: [...campaign.solved],
      };
      setCampaign(updated);
      if (typeof window !== "undefined")
        localStorage.setItem(progKey, JSON.stringify(updated));
      setImg(photos[nextIndex]);
    }
  };
  const handleCloseCongrats = () => setShowCongrats(false);

  // Konfetti flag (a rács fölé)
  const [showConfetti, setShowConfetti] = useState(false);

  // Szint befejezése → mentés + pop-up + SFX + konfetti
  useEffect(() => {
    if (solved && !prevSolvedRef.current) {
      const newSolved = [...campaign.solved];
      if (!newSolved[campaign.index]) newSolved[campaign.index] = true;
      const updated: CampaignState = {
        index: campaign.index,
        solved: newSolved,
      };
      setCampaign(updated);
      if (typeof window !== "undefined")
        localStorage.setItem(progKey, JSON.stringify(updated));

      sfx.win(); // SFX: győzelem
      setShowCongrats(true);
      setShowConfetti(true);
      const t = window.setTimeout(() => setShowConfetti(false), 1400);
      return () => clearTimeout(t);
    }
    prevSolvedRef.current = solved;
  }, [solved]);

  // Manuális kép választás → kampány index update
  const handleSelectImg = (value: string) => {
    const idx = Math.max(
      0,
      photos.findIndex((p) => p === value)
    );
    const updated: CampaignState = { index: idx, solved: [...campaign.solved] };
    setCampaign(updated);
    if (typeof window !== "undefined")
      localStorage.setItem(progKey, JSON.stringify(updated));
    setImg(value);
  };

  // Reset kampány (1. szint NEM kész)
  const resetCampaign = () => {
    const fresh: CampaignState = { index: 0, solved: photos.map(() => false) };
    setCampaign(fresh);
    if (typeof window !== "undefined")
      localStorage.setItem(progKey, JSON.stringify(fresh));
    prevSolvedRef.current = false;
    setImg(photos[0] || DEFAULT_PHOTOS[0] || "");
  };

  const solvedCount = campaign.solved.filter(Boolean).length;
  const progressPct = photos.length
    ? Math.round((solvedCount / photos.length) * 100)
    : 0;

  return (
    <div className="w-full max-w-5xl mx-auto">
      {/* Fejléc + kampány státusz */}
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
            className="px-4 py-2 rounded-xl bg-slate-900 text-amber-300 shadow hover:opacity-90 w-full sm:w-auto"
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

        {/* Kampány UI */}
        <div className="flex flex-col gap-2 w-full sm:w-[420px]">
          <div className="flex items-center justify-between text-sm">
            <div className="font-medium">
              Szint: {campaign.index + 1} / {Math.max(photos.length, 1)}
            </div>
            <div className="text-slate-600">
              Kész: {solvedCount} / {Math.max(photos.length, 1)}
            </div>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {photos.map((_, i) => {
              const isCurrent = campaign.index === i;
              const isSolved = campaign.solved[i];

              const base =
                "relative w-8 h-8 rounded-full border-2 box-border leading-none text-[11px] grid place-items-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:ring-slate-400 active:scale-95";

              const solvedCls =
                "bg-white text-emerald-700 border-emerald-500 hover:bg-emerald-50";
              const currentCls =
                "bg-slate-900 text-amber-300 border-slate-900 hover:bg-slate-900";
              const defaultCls =
                "bg-white border-slate-300 text-slate-700 hover:bg-slate-100";

              const cls = isSolved
                ? solvedCls
                : isCurrent
                ? currentCls
                : defaultCls;

              return (
                <button
                  key={i}
                  onClick={() => handleSelectImg(photos[i])}
                  className={`${base} ${cls}`}
                  title={`Ugrás a(z) ${i + 1}. szintre`}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {i + 1}
                  {isSolved && (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-emerald-500 text-white text-[10px] leading-none grid place-items-center">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={resetCampaign}
              className="text-xs px-3 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
            >
              Kampány visszaállítása
            </button>
            <div className="text-xs text-slate-500">
              Haladás automatikusan mentve
            </div>
          </div>
        </div>
      </div>

      {/* Kép választó */}
      <div className="flex items-center gap-2 w-full mb-3">
        <select
          className="px-3 py-2 rounded-xl bg-white shadow border border-slate-200 w-full sm:max-w-xs"
          value={img}
          onChange={(e) => handleSelectImg(e.target.value)}
        >
          {photos.length === 0 && (
            <option value="">(Tölts fel legalább 1 képet)</option>
          )}
          {photos.map((p, i) => (
            <option key={i} value={p}>{`Kép ${i + 1}`}</option>
          ))}
        </select>
      </div>

      {/* Játékmező + KONFETTI */}
      <div className="relative" onPointerMove={handlePointerMove}>
        {/* GHOST ELŐTÉRBEN: z-20 + pointer-events-none, teljes kép (contain) */}
        {showGhost && img && (
          <div className="absolute inset-0 z-20 rounded-2xl overflow-hidden pointer-events-none">
            <div
              className="w-full h-full opacity-25"
              style={{
                backgroundImage: `url(${img})`,
                backgroundSize: "contain",
                backgroundRepeat: "no-repeat",
                backgroundPosition: "center",
              }}
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
                onClick={() => {
                  if (dragging.active) return;
                  if (selectedOrder == null) setSelectedOrder(order);
                  else if (selectedOrder === order) setSelectedOrder(null);
                  else {
                    onSwap(selectedOrder, order);
                    sfx.flip();
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

        {/* KONFETTI (emoji burst) */}
        {showConfetti && <EmojiConfetti />}

        {/* Pop-up: szint kész / kampány kész */}
        {showCongrats && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
          >
            <div
              className="absolute inset-0 bg-black/40"
              onClick={handleCloseCongrats}
            />
            <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-xl border border-slate-200 p-5 text-center">
              {campaign.index < photos.length - 1 ? (
                <>
                  <div className="text-2xl mb-2">🎉 Szint kész!</div>
                  <p className="text-slate-600 mb-4">Jöhet a következő kép?</p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={handleCloseCongrats}
                      className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50"
                    >
                      Maradok
                    </button>
                    <button
                      onClick={handleNextLevel}
                      className="px-4 py-2 rounded-xl bg-slate-900 text-amber-300 hover:opacity-90"
                    >
                      Tovább
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-2xl mb-2">🏁 Kampány kész!</div>
                  <p className="text-slate-600 mb-4">
                    Gratulálok, az összes képet kiraktad.
                  </p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={handleCloseCongrats}
                      className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50"
                    >
                      Bezár
                    </button>
                    <button
                      onClick={resetCampaign}
                      className="px-4 py-2 rounded-xl bg-slate-900 text-amber-300 hover:opacity-90"
                    >
                      Újrakezdem
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Emoji Confetti komponens ---
function EmojiConfetti({
  count = 28,
  emojis = ["🎉", "🐶", "✨", "🎊"],
  durationMs = 1200,
}: {
  count?: number;
  emojis?: string[];
  durationMs?: number;
}) {
  const items = useMemo(
    () =>
      Array.from({ length: count }).map(() => {
        const angle = Math.random() * Math.PI * 2;
        const dist = 80 + Math.random() * 140; // px
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist * 0.8 - 40; // kicsit felfelé is
        const delay = Math.random() * 0.15; // s
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        const size = 18 + Math.round(Math.random() * 10); // px
        return { dx, dy, delay, emoji, size };
      }),
    [count, emojis]
  );

  return (
    <>
      <style>{`
        @keyframes emoji-burst {
          0% { transform: translate(0,0) scale(.8) rotate(0deg); opacity: 0; }
          10% { opacity: 1; }
          100% { transform: translate(var(--dx), var(--dy)) rotate(360deg) scale(1.1); opacity: 0; }
        }
      `}</style>
      <div className="absolute inset-0 z-30 pointer-events-none">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {items.map((it, i) => {
            const style = {
              ["--dx" as any]: `${it.dx}px`,
              ["--dy" as any]: `${it.dy}px`,
              animation: `emoji-burst ${durationMs}ms ease-out ${it.delay}s forwards`,
              fontSize: `${it.size}px`,
            } as React.CSSProperties as any;
            return (
              <span
                key={i}
                style={style}
                className="absolute select-none"
                aria-hidden="true"
              >
                {it.emoji}
              </span>
            );
          })}
        </div>
      </div>
    </>
  );
}

// -------------------- FOTÓK KEZELÉSE + SHELL --------------------

function PhotoLoader({ onAdd }: { onAdd: (urls: string[]) => void }) {
  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const dataUrls: string[] = [];
    for (const f of files) {
      try {
        const du = await fileToDataUrl(f, 1400);
        dataUrls.push(du);
      } catch {
        // hiba esetén átugorjuk
      }
    }
    if (dataUrls.length) onAdd(dataUrls);
    e.target.value = "";
  };

  return (
    <label className="inline-flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2 rounded-xl bg-white shadow border border-slate-200 cursor-pointer hover:bg-slate-50 text-sm">
      <input
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onChange}
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
  // Betöltjük a felhasználó által korábban feltöltött képeket is
  const [photos, setPhotos] = useState<string[]>(() => initialPhotos);
  useEffect(() => {
    const stored = loadUserPhotos();
    if (stored.length) {
      setPhotos((prev) => Array.from(new Set([...prev, ...stored])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hozzáadás + mentés localStorage-be
  const addPhotos = (urls: string[]) => {
    const currentStored = loadUserPhotos();
    const mergedStored = Array.from(new Set([...currentStored, ...urls]));
    saveUserPhotos(mergedStored);
    setPhotos((prev) => Array.from(new Set([...prev, ...urls])));
  };

  // SFX toggle (globális)
  const [sfxEnabled, setSfxEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = localStorage.getItem(LS_SFX_KEY);
    return raw == null ? true : raw === "true";
  });
  useEffect(() => {
    if (typeof window !== "undefined")
      localStorage.setItem(LS_SFX_KEY, String(sfxEnabled));
  }, [sfxEnabled]);
  const sfx = useSfx(sfxEnabled);

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
            {/* SFX kapcsoló */}
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white shadow border border-slate-200 text-sm">
              <input
                type="checkbox"
                checked={sfxEnabled}
                onChange={(e) => setSfxEnabled(e.target.checked)}
              />
              🔊 Hangok
            </label>

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

        {photos.length === 0 && (
          <div className="mb-6 p-4 bg-white border border-slate-200 rounded-xl shadow text-sm">
            Nincs még kép hozzáadva. Katt a{" "}
            <span className="font-medium">“Képek hozzáadása”</span> gombra és
            válassz ki néhány kedvenc kutyás fotót! 😊
          </div>
        )}

        {tab === "memory" ? (
          <MemoryGame photos={photos} sfx={sfx} />
        ) : (
          <JigsawPuzzle photos={photos} sfx={sfx} />
        )}

        <footer className="mt-8 text-xs text-slate-500">
          Tipp: a legjobb élményhez mobilon is próbáld ki; a Memory játék menti
          a legjobb időt nehézség szerint. A Kirakó szintekben halad, a
          haladásod és a feltöltött képeid automatikusan mentődnek. Hangok a
          fejlécben kapcsolhatók ki/be.
        </footer>
      </div>
    </div>
  );
}
