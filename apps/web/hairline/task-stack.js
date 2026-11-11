/**
 * Task stack: six task sheets squared into a neat pile, held by a rivet at
 * their far corner. Each sheet carries a heading and four ruled rows, each with
 * a checkbox; the boxes already ticked are dots, so every sheet is told apart
 * by geometry. The pointer's place across the top chooses how deep to peek:
 * the sheets above that depth lift and fan out round the rivet, staggered
 * outwards from the sheet chosen, whose edge takes the bright stroke. The
 * slider is the stagger, in ms.
 *
 * The pattern: discrete items, as Riffle. Tweens, a stagger by distance, and a
 * hit test on the ground plan of the resting pile, which never moves.
 */
const { Cam, clamp, fillet, fit, poly, proj, rrect, seg, tdone, tset, tval, tween, unproj, disposer, mk, place, pointer, register } = HL;

const N = 6, W = 92, D = 116, G = 4.2, TK = 1.3, R = 3;
const PX = 9, PY = 9, SPREAD = 8, LIFT = 7, K = 4;
const REST = [-1.6, 1.2, -0.6, 2, -1, 2.8];
const DONE = [3, 1, 2, 0, 2, 1];
const ROWS = [44, 62, 80, 98];

/** A world point on sheet i's plane, from its own (u, v), turned th degrees round the rivet and lifted. */
const at = (P, u, v, th, z) => {
  const s = Math.sin((th * Math.PI) / 180), c = Math.cos((th * Math.PI) / 180), du = u - PX, dv = v - PY;
  return P(PX + du * c - dv * s, PY + du * s + dv * c, z);
};

/** Sheet i at angle th and height z: its back, face, heading, checkbox rings and rules, and where its dots sit. */
function pose(P, shape, th, z) {
  const w = (u, v) => at(P, u, v, th, z);
  const box = (v) => poly(rrect(13, v - 4.2, 21.4, v + 4.2, 1.6, 2).map((q) => w(q.u, q.v)));
  return {
    back: poly(shape.map((p) => at(P, p[0], p[1], th, z - TK))),
    face: poly(shape.map((p) => w(p[0], p[1]))),
    head: seg(w(13, 24), w(58, 24)),
    boxes: ROWS.map(box).join(""),
    rules: ROWS.map((v, j) => seg(w(28, v), w(W - 12 - (j % 2) * 16, v))).join(""),
    dots: ROWS.map((v) => w(17.2, v)),
  };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let stag = value;
  const ZT = (N - 1) * G;
  const shape = fillet([[0, 0], [W, 0], [W, D], [0, D]], [R, R, R, R]);

  // The camera is fitted to the pile with its top sheets fanned all the way, so no pose leaves the frame.
  const C = Cam(45, 0.5, 2.0);
  const ext = [[0, 0, -TK], [W, 0, -TK], [W, D, -TK], [0, D, -TK]];
  for (const th of [-3, SPREAD * K + 3]) for (const [u, v] of [[W, 0], [W, D], [0, D]]) {
    const s = Math.sin((th * Math.PI) / 180), c = Math.cos((th * Math.PI) / 180);
    ext.push([PX + (u - PX) * c - (v - PY) * s, PY + (u - PX) * s + (v - PY) * c, ZT + LIFT]);
  }
  fit(C, ext, 200, 166);
  const P = proj(C);

  const g = mk("g", {}, svg);
  const sheets = [];
  for (let i = 0; i < N; i++) {
    const grp = mk("g", {}, g);
    const back = mk("path", { class: "lo" }, grp), face = mk("path", { class: "sil" }, grp);
    const head = mk("path", { class: "nf" }, grp), boxes = mk("path", { class: "nf lo" }, grp), rules = mk("path", { class: "nf lo" }, grp);
    // the rows already done carry a dot in their box; the top sheet's first box is the rest mark
    const dots = ROWS.map((_, j) => (j < DONE[i] || (i === N - 1 && j === 0) ? mk("circle", { r: 1.6, class: i === N - 1 ? "dot" : "dot m" }, grp) : null));
    sheets.push({ back, face, head, boxes, rules, dots, a: tween(REST[i]), z: tween(0), last: "" });
  }
  // the rivet the sheets turn on, through the whole pile at the far corner
  const rivet = mk("path", { class: "nf" }, g), rivetIn = mk("path", { class: "nf lo" }, g);
  let rz = NaN;
  /** The rivet's head rides on the top sheet, so it lifts with it. */
  function drawRivet(z) {
    if (z === rz) return;
    rz = z;
    rivet.setAttribute("d", poly(rrect(PX - 3.4, PY - 3.4, PX + 3.4, PY + 3.4, 3.4, 4).map((q) => P(q.u, q.v, z))));
    rivetIn.setAttribute("d", poly(rrect(PX - 1.5, PY - 1.5, PX + 1.5, PY + 1.5, 1.5, 3).map((q) => P(q.u, q.v, z))));
  }

  function draw(i, th, lift) {
    const sh = sheets[i], key = th.toFixed(3) + "," + lift.toFixed(3);
    if (key === sh.last) return;
    sh.last = key;
    const q = pose(P, shape, th, i * G + lift);
    sh.back.setAttribute("d", q.back);
    sh.face.setAttribute("d", q.face);
    sh.head.setAttribute("d", q.head);
    sh.boxes.setAttribute("d", q.boxes);
    sh.rules.setAttribute("d", q.rules);
    sh.dots.forEach((el, j) => el && place(el, q.dots[j]));
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    sheets.forEach((sh, i) => { draw(i, tval(sh.a, now), tval(sh.z, now)); if (!tdone(sh.a, now) || !tdone(sh.z, now)) moving = true; });
    drawRivet(ZT + 0.4 + Math.round(tval(sheets[N - 1].z, now) * 1000) / 1000);
    return moving;
  });
  bag.add(B.unregister);

  /** The sheet to peek at, from the RESTING pile's plan on the top sheet's plane; -1 off the pile. Left to right goes deeper. */
  function hit([sx, sy]) {
    const [x, y] = unproj(C, sx, sy, ZT);
    if (x < -8 || y < -8 || x > W + 8 + ZT * 1.6 || y > D + 8 + ZT * 1.6) return -1;
    const t = clamp((x - y + D) / (W + D), 0, 0.999);
    return N - 2 - Math.floor(t * K);
  }

  let act = -1;
  /** Peeks at sheet a (-1 squares the pile again): the sheets above it fan out, staggered from it. */
  function setActive(a) {
    if (a === act) return;
    const now = performance.now(), from = a >= 0 ? a : act;
    act = a;
    sheets.forEach((sh, i) => {
      const delay = Math.abs(i - from) * stag, up = a >= 0 && i > a;
      tset(sh.a, up ? REST[i] + SPREAD * (i - a) : REST[i], now, delay);
      tset(sh.z, up ? LIFT : 0, now, delay);
      sh.face.classList.toggle("hi", i === a);
    });
    sheets[N - 1].dots[0].setAttribute("class", a < 0 ? "dot" : "dot m");
    read.textContent = a < 0 ? "rest" : "peek";
    B.wake();
  }

  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { stag = v; },
    destroy: bag.dispose,
  };
}

hairline({
  name: "task-stack",
  means: "A neat stack of task sheets: hover across it and the top sheets fan apart in turn to let you peek beneath.",
  rules: [1, 2, 5, 8],
  range: [0, 45, 90],
  tour: [[120, 152], [235, 148], [335, 142], null],
  mount,
});
