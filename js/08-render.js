/* ---------------------------- Рендер ---------------------------- */
// ИИ (стиль/анимация/мобайл): полная переработка визуального слоя. Логика
// State/gameTick не тронута ни на строчку — здесь только то, ЧТО и КАК
// рисуется на canvas. Раньше юниты были одинаковыми кружками, а здания —
// плоскими цветными прямоугольниками; теперь у каждого типа юнита свой
// силуэт (кузов/оружие/поворот к цели), у зданий — панельная текстура и
// огоньки, а ключевые события (попадание, смерть, появление, выделение)
// анимированы во времени через performance.now(), а не статичны.
//
// Анимационное состояние (angle, hitFlash, spawnT, deathT...) хранится
// ПРЯМО на игровых объектах (u.__vis / b.__vis) как приватное поле рендера
// — это чисто визуальный кэш, gameTick/State ничего о нём не знает и не
// обязан знать. Поле лениво создаётся при первой отрисовке объекта.

const FX = {
  deaths: [],     // {x,y,color,t0,kind:'unit'|'building'|'vehicle'}
  hitSparks: [],  // {x,y,t0,angle} — искры в момент попадания (раньше пушились, но не рисовались — утечка, исправлено)
  tracks: [],     // {x,y,angle,t0,w} — затухающие следы гусениц/колёс техники
  projectiles: [],// {x0,y0,x1,y1,t0,dur,kind:'bullet'|'shell'|'rocket'} — летящий снаряд от выстрела до цели
  impacts: [],    // {x,y,t0,kind:'small'|'big'} — вспышка+кольцо ударной волны в точке попадания
  shake: { t0: 0, mag: 0, dur: 0 }, // тряска камеры/канваса при крупных взрывах
};

function nowT() { return performance.now(); }

// ОПТИМИЗАЦИЯ (перф): большинство линейных градиентов в drawUnit/drawBuilding
// рисуются в ЛОКАЛЬНЫХ координатах (после ctx.translate/ctx.rotate) и их
// геометрия (x0,y0,x1,y1) полностью определяется размером юнита/здания —
// то есть одинакова для всех объектов одного типа. Раньше на каждый юнит
// каждый кадр создавался НОВЫЙ объект CanvasGradient (ctx.createLinearGradient
// + 2х addColorStop) — на телефоне при паре десятков юнитов в кадре это
// десятки лишних аллокаций 60 раз в секунду, одна из главных причин нагрева.
// cachedLinearGradient() держит один CanvasGradient на уникальную комбинацию
// координат+цветов и переиспользует его во всех последующих кадрах — сам
// градиент как визуальный объект от этого не меняется ни на пиксель.
const _gradientCache = new Map();
function cachedLinearGradient(x0, y0, x1, y1, colorA, colorB, key) {
  const cacheKey = key || (x0 + "," + y0 + "," + x1 + "," + y1 + "|" + colorA + "|" + colorB);
  let g = _gradientCache.get(cacheKey);
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, colorA);
    g.addColorStop(1, colorB);
    _gradientCache.set(cacheKey, g);
  }
  return g;
}

// Возвращает (и лениво создаёт) приватный визуальный стейт объекта.
function visState(obj) {
  if (!obj.__vis) {
    obj.__vis = {
      angle: 0,             // текущий угол поворота (рад), сглаживается к target
      targetAngle: 0,
      lastHp: obj.hp,
      hitFlashT: -999,      // время последнего попадания (nowT()), для белой вспышки
      spawnT: nowT(),        // время первого появления в рендере — для scale-in
      bob: Math.random() * Math.PI * 2, // фазовый сдвиг для лёгкого "дыхания"/покачивания
      lastMoveX: obj.x,      // позиция юнита в предыдущем отрисованном кадре —
      lastMoveY: obj.y,      // нужна, чтобы считать угол по РЕАЛЬНОМУ вектору
                              // перемещения (см. drawUnit), а не по статичной
                              // точке-цели, которая может лежать за препятствием.
    };
  }
  return obj.__vis;
}

// Общая проверка "попало ли по объекту в этот кадр" — сравниваем hp с
// прошлым отрисованным значением. Дёшево и не требует хуков в боевую систему.
// ИИ (визуал): раньше пушило в FX.hitSparks, но ничего не рисовало этот
// массив (утечка + упущенный эффект) — теперь рисуется в drawHitSparks
// (см. ниже), плюс добавлен angle для направленного разлёта и triggerShake
// при заметном одиночном уроне (крупнокалиберное попадание ощутимо трясёт
// камеру, мелкие тычки пехоты — нет).
function updateHitFlash(obj, vis) {
  if (obj.hp < vis.lastHp - 0.001) {
    const dmg = vis.lastHp - obj.hp;
    vis.hitFlashT = nowT();
    const sparkAngle = vis.angle != null ? vis.angle + Math.PI : Math.random() * Math.PI * 2;
    FX.hitSparks.push({ x: obj.x, y: obj.y, t0: nowT(), angle: sparkAngle });
    if (dmg >= 20) triggerShake(Math.min(6, dmg / 12), 180);
  }
  vis.lastHp = obj.hp;
}

// Тряска экрана — накапливает магнитуду, не перезаписывает более сильный
// текущий шейк более слабым (несколько взрывов подряд не должны "срезать"
// друг друга). Применяется в render() к ctx перед отрисовкой сцены.
function triggerShake(mag, dur) {
  const remaining = FX.shake.t0 ? Math.max(0, FX.shake.dur - (nowT() - FX.shake.t0)) : 0;
  const remainingMag = remaining > 0 ? FX.shake.mag * (remaining / FX.shake.dur) : 0;
  if (mag >= remainingMag) {
    FX.shake.t0 = nowT();
    FX.shake.mag = mag;
    FX.shake.dur = dur;
  }
}

function render() {
  const t = nowT();

  // тряска камеры — временный сдвиг ctx перед отрисовкой сцены, гасится
  // по времени, амплитуда убывает линейно к нулю (см. triggerShake выше)
  ctx.save();
  const shakeElapsed = t - FX.shake.t0;
  if (FX.shake.t0 && shakeElapsed < FX.shake.dur) {
    const decay = 1 - shakeElapsed / FX.shake.dur;
    const m = FX.shake.mag * decay;
    ctx.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2);
  }

  ctx.fillStyle = "#141a10";
  ctx.fillRect(0, 0, canvas.logicalWidth, canvas.logicalHeight);

  // ИИ (зум камеры, по прямому запросу пользователя): единая точка
  // масштабирования всей сцены. Всё, что рисуется НИЖЕ (текстура земли,
  // ресурсы, здания, юниты, эффекты, туман), использует "дозумовые"
  // worldToScreen-координаты (см. 02-utils-canvas.js) — ctx.scale сам
  // растягивает и позиции, и размеры одинаково, поэтому ни один из
  // вызовов отрисовки ниже менять не нужно. Фон уже залит строкой выше,
  // ДО scale, поэтому очистка экрана всегда покрывает весь канвас
  // независимо от текущего zoom.
  ctx.scale(State.camera.zoom, State.camera.zoom);

  drawGroundTexture(t);
  drawGroundTracks(t); // затухающие следы гусениц/колёс — рисуются ДО юнитов, под ними

  // ресурсы
  Object.values(State.resources).forEach(r => drawResourceNode(r, t));

  // здания (сортировка по Y — что "ниже" на экране, то рисуется поверх, псевдо-3D)
  const buildingsSorted = Object.values(State.buildings).filter(b => {
    if (!GameConfig.fogEnabled) return true;
    if (b.ownerId === localPlayerId) return true;
    return isWorldPointVisible(b.x, b.y);
  }).sort((a, b) => a.y - b.y);
  buildingsSorted.forEach(b => drawBuilding(b, t));

  // юниты (тоже по Y)
  const unitsSorted = Object.values(State.units).filter(u => {
    if (!GameConfig.fogEnabled) return true;
    if (u.ownerId === localPlayerId) return true;
    return isWorldPointVisible(u.x, u.y);
  }).sort((a, b) => a.y - b.y);
  unitsSorted.forEach(u => drawUnit(u, t));

  // ИИ №45: БАГФИКС по прямому запросу пользователя — серые силуэты
  // remoteGhosts рисовались ВСЕГДА, в т.ч. в режиме "ai" (не-PvP), где чужие
  // здания/юниты вообще не должны быть видны этому клиенту (комната теперь
  // изолирована на уровне roomId, см. 01-config-state.js, но эта проверка —
  // дополнительный защитный слой, а не единственная линия обороны). В
  // режиме "pvp" renderRemoteGhosts() тоже больше не нужен: оппонент уже
  // полноценно материализован в State.units/State.buildings и рисуется
  // обычными drawUnit/drawBuilding выше по циклу — см. явный комментарий
  // об этом в шапке 18-pvp-multiplayer.js ("самое чистое решение: пропускать
  // renderRemoteGhosts() целиком в pvp"). Итог — функция больше не нужна ни
  // в одном режиме, оставляем её объявленной (на случай будущего PvP-режима
  // без полной материализации), но не вызываем.
  if (false) renderRemoteGhosts();
  drawFogBuildingMemory(t); // "снимки" вражеских зданий в разведанной, но не видимой сейчас зоне
  drawProjectiles(t);       // летящие снаряды/трассеры — поверх юнитов, под эффектами попадания
  drawImpacts(t);           // вспышки+кольца ударной волны в точках попадания
  drawHitSparks(t);         // разлетающиеся искры при получении урона
  drawDeathEffects(t);       // догорающие эффекты смерти (поверх туманной памяти, под самим туманом)
  drawBuildGhost();          // призрак строящегося здания поверх всего остального
  drawFogOverlay();          // сама завеса тумана — рисуется последней, поверх всего игрового мира

  ctx.restore(); // конец тряски камеры
}

/* ================================================================
   КАРТИНКА ТРАВЫ ДЛЯ ФОНА
   Файл лежит в той же папке, что и этот скрипт (08-render.js) — путь
   резолвится относительно document.currentScript, поэтому сработает
   независимо от того, где лежит сама game.html.
   ================================================================ */
const GROUND_TEXTURE_URL = (() => {
  try {
    return new URL(
      "1672801832_grizly-club-p-tekstura-travi-pikselnaya-4.jpg",
      document.currentScript.src
    ).href;
  } catch (e) {
    return "1672801832_grizly-club-p-tekstura-travi-pikselnaya-4.jpg";
  }
})();
const groundTextureImg = new Image();
groundTextureImg.src = GROUND_TEXTURE_URL;

// Паттерн создаём один раз (после загрузки картинки) и кэшируем — не
// пересоздавать же его каждый кадр в 60fps цикле.
let _groundPattern = null;
function getGroundPattern() {
  if (!groundTextureImg.complete || !groundTextureImg.naturalWidth) return null; // ещё грузится
  if (!_groundPattern) _groundPattern = ctx.createPattern(groundTextureImg, "repeat");
  return _groundPattern;
}

/* ================================================================
   ФОН / ТЕКСТУРА ЗЕМЛИ
   ================================================================ */
// ИИ (визуал): раньше здесь была сплошная процедурная заливка (лёгкий
// градиент + сетка линий + случайные пятна "травы"), из-за которой карта
// выглядела как плоские зелёные квадраты. Теперь под ней — настоящая
// картинка травы, замощённая (repeat) по всей карте и привязанная к
// МИРОВЫМ координатам (см. блок с pattern ниже). Старый фон поверх неё —
// это уже не набор еле заметных линий/градиента (их alpha 0.015-0.05 почти
// не видна поверх фотографии, из-за чего текстура казалась "чистой"), а
// прямая тёмно-зелёная полупрозрачная заливка КАЖДОЙ клетки шахматного
// порядка (#141a10, тот же тон, что был у старого сплошного фона) — она
// заметно затемняет траву под собой, но не перекрывает её полностью.
function drawGroundTexture(t) {
  const ts = GameConfig.tileSize;
  const pattern = getGroundPattern();
  if (pattern) {
    const bigTs = ts * 6; // одна плитка картинки = 6x6 игровых клеток
    const scale = bigTs / groundTextureImg.naturalWidth;
    // положительный остаток от деления (в JS % может давать отрицательное
    // число при отрицательной координате камеры)
    const offXImg = -(((State.camera.x % bigTs) + bigTs) % bigTs);
    const offYImg = -(((State.camera.y % bigTs) + bigTs) % bigTs);
    const m = new DOMMatrix().translate(offXImg, offYImg).scale(scale, scale);
    pattern.setTransform(m);
    ctx.save();
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, visibleWorldWidth(), visibleWorldHeight());
    ctx.restore();
  }
  // Пока картинка ещё не загрузилась, pattern === null и здесь ничего не
  // рисуется — под этим слоем остаётся сплошная заливка "#141a10" из
  // render(), так что пустого/белого экрана не будет, просто на секунду
  // фон будет однотонным, а не травяным.

  // --- тёмно-зелёные квадратики поверх травы, в шахматном порядке ---
  const offX = -State.camera.x % ts;
  const offY = -State.camera.y % ts;
  const col0 = Math.floor(State.camera.x / ts);
  const row0 = Math.floor(State.camera.y / ts);
  ctx.save();
  ctx.fillStyle = "rgba(20,26,16,0.27)"; // тёмно-зелёный (#141a10), 40% непрозрачности — именно ЗАТЕМНЕНИЕ, а не сплошная заливка
  let col = col0;
  for (let x = offX; x < visibleWorldWidth(); x += ts, col++) {
    let row = row0;
    for (let y = offY; y < visibleWorldHeight(); y += ts, row++) {
      if (((col + row) & 1) === 0) ctx.fillRect(x, y, ts, ts);
    }
  }
  ctx.restore();
}

// Затухающие следы гусениц/колёс — регистрируются из drawTank/drawApc при
// движении (см. пуш в FX.tracks там), живут ~4с и линейно гаснут. Дёшево:
// один короткий отрезок за тик движения на юнит, список триммируется по
// возрасту здесь же, никакой утечки. Чисто визуальный слой, не в State.
function drawGroundTracks(t) {
  for (let i = FX.tracks.length - 1; i >= 0; i--) {
    const tr = FX.tracks[i];
    const age = t - tr.t0;
    const dur = 4000;
    if (age > dur) { FX.tracks.splice(i, 1); continue; }
    const s = worldToScreen(tr.x, tr.y);
    if (s.x < -20 || s.y < -20 || s.x > visibleWorldWidth() + 20 || s.y > visibleWorldHeight() + 20) continue;
    const alpha = (1 - age / dur) * 0.22;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(tr.angle);
    ctx.fillStyle = `rgba(20,18,14,${alpha})`;
    ctx.fillRect(-tr.w / 2, -1.1, tr.w, 1);
    ctx.fillRect(-tr.w / 2, 2.1, tr.w, 1);
    ctx.restore();
  }
}

/* ================================================================
   РЕСУРСЫ
   ================================================================ */
function drawResourceNode(r, t) {
  const s = worldToScreen(r.x, r.y);
  if (s.x < -24 || s.y < -24 || s.x > visibleWorldWidth() + 24 || s.y > visibleWorldHeight() + 24) return;

  const pulse = 1 + Math.sin(t / 900 + r.x * 0.01) * 0.05;
  const depleting = r.amount < 300; // просто визуальная деградация по мере выработки

  ctx.save();
  // мягкое свечение — делает узлы читаемыми издалека на фоне земли
  const glow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 16 * pulse);
  glow.addColorStop(0, depleting ? "rgba(201,162,39,0.35)" : "rgba(111,143,58,0.35)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(s.x, s.y, 16 * pulse, 0, Math.PI * 2); ctx.fill();

  // кристалл-кластер вместо простого кружка: несколько гранёных форм
  const baseColor = depleting ? "#c9a227" : "#6f8f3a";
  const darkColor = depleting ? "#8a6f1a" : "#496024";
  [[0, 0, 9], [6, 4, 6], [-6, 3, 6.5], [2, -6, 5.5]].forEach(([dx, dy, size], i) => {
    const cx = s.x + dx, cy = s.y + dy - 2;
    ctx.fillStyle = i === 0 ? baseColor : darkColor;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx + size * 0.8, cy - size * 0.2);
    ctx.lineTo(cx + size * 0.5, cy + size * 0.7);
    ctx.lineTo(cx - size * 0.5, cy + size * 0.7);
    ctx.lineTo(cx - size * 0.8, cy - size * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  ctx.restore();
}

/* ================================================================
   ЗДАНИЯ
   ================================================================ */
function drawBuilding(b, t) {
  const def = BuildingDefs[b.type];
  if (!def) return;
  const vis = visState(b);
  updateHitFlash(b, vis);

  const s = worldToScreen(b.x, b.y);
  const w = def.w * GameConfig.tileSize, h = def.h * GameConfig.tileSize;
  if (s.x < -w - 20 || s.y < -h - 20 || s.x > visibleWorldWidth() + w + 20 || s.y > visibleWorldHeight() + h + 20) return;

  const player = State.players[b.ownerId];
  const baseColor = player ? player.color : "#888";

  // появление: короткий scale-in из центра, чтобы новая постройка не
  // "телепортировалась" на карту мгновенно
  const spawnAge = t - vis.spawnT;
  const spawnScale = spawnAge < 260 ? 0.7 + 0.3 * easeOutBack(Math.min(1, spawnAge / 260)) : 1;

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.scale(spawnScale, spawnScale);
  ctx.translate(-s.x, -s.y);

  // мягкая тень на земле — придаёт объём плоскому спрайту
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(s.x, s.y + h / 2 + 3, w / 2 + 3, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawBuildingBody(b, def, s, w, h, baseColor, t);

  // ИИ (визуал): горящие повреждённые здания — классический RTS-сигнал
  // "эта постройка в беде", читается издалека без необходимости смотреть на
  // hp-бар. Порог 50% — здание уже подгорает, но ещё не критично; ниже 25%
  // добавляется более густой/крупный дым поверх того же огня.
  if (b.hp < b.maxHp * 0.5) {
    drawBuildingFire(b, s, w, h, t);
  }

  // вспышка попадания — белая обводка/подсветка гаснущая за ~180мс
  const sinceHit = t - vis.hitFlashT;
  if (sinceHit < 180) {
    ctx.save();
    ctx.globalAlpha = 1 - sinceHit / 180;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(s.x - w / 2, s.y - h / 2, w, h);
    ctx.restore();
  }

  // hp bar (только если здание не в полном здоровье ИЛИ выделено — чтобы не
  // засорять экран баром на 100% HP у построек, которые никто не трогал)
  if (b.hp < b.maxHp - 0.5 || State.selection.has(b.id)) {
    drawHpBar(s.x - w / 2, s.y - h / 2 - 9, w, b.hp, b.maxHp);
  }

  if (State.selection.has(b.id)) {
    drawSelectionRectAnimated(s.x - w / 2 - 4, s.y - h / 2 - 4, w + 8, h + 8, t);

    if (def.canAttack) {
      ctx.save();
      ctx.strokeStyle = "rgba(201,162,39,0.35)";
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -(t / 40) % 8;
      ctx.beginPath();
      ctx.arc(s.x, s.y, def.attackRange, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (def.canAttack && b.attackTargetId) {
    const target = findAttackableAt(b.attackTargetId);
    if (target) drawAttackTracer(s.x, s.y, target, t);
  }

  ctx.restore(); // scale-in transform
}

// Панельный корпус здания: базовая заливка цветом владельца + тёмная рамка
// панелей + пара "окон"/огней (мигают, если здание питается) + дымоход для
// электростанции. Разные def.produces/canAttack дают чуть разные детали,
// не отдельные спрайты на каждый тип — тут прототип, не арт-пайплайн.
// ИИ (визуал): раньше ВСЕ здания рисовали один и тот же скруглённый
// прямоугольник (roundRect на всю w×h) и отличались только маленькой
// деталью по центру — силуэты по факту не читались, все постройки казались
// "той же коробкой перекрашенной". Теперь форма корпуса — часть роутинга
// по типу (drawBuildingShape), не общий код: у каждого здания свой контур
// (штаб — многоярусный, казармы — покатая крыша ангара, электростанция —
// восьмиугольный реактор, завод — низкий грузовой блок, аэродром — длинная
// платформа с ВПП-полосой, турель — компактный круглый бункер), поверх
// формы уже накладываются общие детали (панельные линии, огоньки), которые
// подстраиваются под контур, а не рисуются вслепую по прямоугольнику.
function drawBuildingBody(b, def, s, w, h, baseColor, t) {
  drawBuildingShape(b.type, s, w, h, baseColor);

  // огоньки-индикаторы вдоль нижнего края — мигают асинхронно по фазе tick,
  // условно показывают "здание запитано и работает". Держим поверх любой
  // формы корпуса — читаемый общий язык для "живое здание", независимо от
  // конкретного силуэта.
  const y0 = s.y - h / 2;
  const lightCount = Math.max(2, Math.round(w / 14));
  for (let i = 0; i < lightCount; i++) {
    const lx = s.x - w / 2 + (w / (lightCount + 1)) * (i + 1);
    const phase = Math.sin(t / 500 + i * 1.7);
    const on = phase > -0.2;
    ctx.fillStyle = on ? "rgba(230,188,58,0.9)" : "rgba(60,50,20,0.6)";
    if (on) { ctx.shadowColor = "rgba(230,188,58,0.8)"; ctx.shadowBlur = 4; }
    ctx.beginPath(); ctx.arc(lx, y0 + h - 5, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // деталь по роли здания
  if (b.type === "refinery") {
    // ИИ №29: проверка типа СТРОГО раньше producesPower/canAttack/produces
    // — refinery не подходит ни под одну из этих веток (не производит
    // питание, не атакует, ничего не нанимает), иначе провалился бы в
    // фолбэк drawCommandCenterDetail, что визуально неверно.
    drawRefineryDetail(s, w, h, t);
  } else if (def.producesPower > 0) {
    drawPowerPlantDetail(s, w, h, t);
  } else if (def.canAttack) {
    drawTurretDetail(b, s, t);
  } else if (def.produces && def.produces.length) {
    drawFactoryDetail(s, w, h, def);
  } else {
    drawCommandCenterDetail(s, w, h, t);
  }
}

// Роутер формы корпуса по типу здания — каждый case рисует ПОЛНОСТЬЮ свой
// контур (не общий roundRect с параметрами), поэтому силуэты действительно
// разные, а не один и тот же прямоугольник с деталью по центру.
// ИИ (визуал, доп. контраст): помимо формы, у каждого типа теперь ещё и
// собственный акцентный оттенок КРЫШИ — не производный от baseColor (цвета
// фракции), а отдельный "материальный" цвет роли (ржавый металл завода,
// голубоватый бетон электростанции и т.д.), нанесённый поверх основной
// заливки узкой полосой по периметру. Сам корпус остаётся в цвете фракции
// (иначе непонятно, чьё здание), но эта окантовка — доп. ось различия,
// работающая даже если два здания одного игрока стоят рядом.
const BuildingAccent = {
  commandCenter: "#c9a227",
  powerPlant: "#5aa8c9",
  barracks: "#7a8a5a",
  warFactory: "#9a6a3a",
  airfield: "#8a92a0",
  turret: "#a03a30",
  // ИИ №29: refinery — здание добычи ресурсов (замена юнита-рабочего).
  // Ржаво-жёлтый акцент ассоциируется с рудой/переработкой, отличим от
  // золотистого штаба (тот чуть светлее и без красноватого оттенка).
  refinery: "#c07a2a",
};
function drawBuildingShape(type, s, w, h, baseColor) {
  const x0 = s.x - w / 2, y0 = s.y - h / 2;
  const grad = ctx.createLinearGradient(0, y0, 0, y0 + h);
  grad.addColorStop(0, lighten(baseColor, 18));
  grad.addColorStop(1, darken(baseColor, 22));

  // БАГФИКС (по прямому запросу пользователя: "здания немного большие,
  // заходят за клетку пикселей на 3-5"): canvas stroke() центрирует линию
  // НА контуре пути, а не внутри него — при lineWidth 1.5 половина линии
  // (0.75px) физически выходит ЗА x0..x0+w/y0..y0+h, ровно ту границу,
  // которую isBuildPlacementValid/snapBuildingCenterToGrid считают
  // footprint здания на тайловой сетке. У впритык поставленных соседних
  // зданий (после фикса BUILD_GAP=0, 10-hud.js) обводки визуально
  // перекрывались этим на 1.5px суммарно на стыке (по 0.75px с каждой
  // стороны). SI — половина стандартной толщины обводки контура (1.5),
  // используется как инсет для боковых x0/x0+w везде, где форма идёт
  // вплотную к боковым границам клетки (что справедливо для всех типов —
  // только верх/низ у некоторых форм имеет отступ под крышу/навес, бока
  // всегда полная w). Верхний/нижний контур НЕ трогаю симметрично —
  // формы с отступом (barracks/warFactory/airfield/refinery) и так не
  // достают до верхней/нижней границы footprint, а у commandCenter/
  // powerPlant/фолбэк, которые используют полный h, инсет применяется по
  // всем 4 сторонам одинаково (см. их код ниже).
  const SI = 0.75;

  if (type === "commandCenter") {
    // многоярусный штаб — широкое основание + приподнятая узкая надстройка
    // по центру (второй "этаж"), самое крупное и самое "архитектурное"
    // здание в игре, как и полагается главной постройке.
    ctx.fillStyle = grad;
    roundRect(x0 + SI, y0 + SI, w - SI * 2, h - SI * 2, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5;
    roundRect(x0 + SI, y0 + SI, w - SI * 2, h - SI * 2, 4); ctx.stroke();

    const innerW = w * 0.52, innerH = h * 0.46;
    const ix0 = s.x - innerW / 2, iy0 = s.y - h / 2 - innerH * 0.32;
    const innerGrad = ctx.createLinearGradient(0, iy0, 0, iy0 + innerH);
    innerGrad.addColorStop(0, lighten(baseColor, 30));
    innerGrad.addColorStop(1, darken(baseColor, 12));
    ctx.fillStyle = innerGrad;
    roundRect(ix0, iy0, innerW, innerH, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.2;
    roundRect(ix0, iy0, innerW, innerH, 3); ctx.stroke();

    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
    const cols = Math.max(1, Math.round(w / 22));
    for (let i = 1; i < cols; i++) {
      const px = x0 + (w / cols) * i;
      ctx.beginPath(); ctx.moveTo(px, y0 + h * 0.45); ctx.lineTo(px, y0 + h - 3); ctx.stroke();
    }
  } else if (type === "powerPlant") {
    // восьмиугольный реактор — единственное здание со срезанными углами,
    // сразу читается на карте как "энергетический" объект по одной форме.
    // Инсет (SI) применён ко всем координатам контура — форма (включая
    // срезы углов) укладывается строго в footprint вместе с обводкой.
    const iw = w - SI * 2, ih = h - SI * 2;
    const ix0 = x0 + SI, iy0 = y0 + SI;
    const cut = Math.min(iw, ih) * 0.28;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ix0 + cut, iy0); ctx.lineTo(ix0 + iw - cut, iy0);
    ctx.lineTo(ix0 + iw, iy0 + cut); ctx.lineTo(ix0 + iw, iy0 + ih - cut);
    ctx.lineTo(ix0 + iw - cut, iy0 + ih); ctx.lineTo(ix0 + cut, iy0 + ih);
    ctx.lineTo(ix0, iy0 + ih - cut); ctx.lineTo(ix0, iy0 + cut);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5; ctx.stroke();
  } else if (type === "barracks") {
    // покатая двускатная крыша ангара — треугольный конёк поверх нижнего
    // прямоугольного основания, как классический казарменный барак.
    // Инсет по бокам (x0+SI..x0+w-SI) — корпус и обводка не выходят за
    // боковые границы клетки; верх намеренно не трогаю (крыша уже с
    // отступом от верхней границы footprint через h*0.22).
    ctx.fillStyle = grad;
    roundRect(x0 + SI, y0 + h * 0.22, w - SI * 2, h * 0.78 - SI, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5;
    roundRect(x0 + SI, y0 + h * 0.22, w - SI * 2, h * 0.78 - SI, 3); ctx.stroke();

    // БАГФИКС (по прямому запросу пользователя: "здания немного большие,
    // заходят за клетку пикселей на 3-5") — раньше скат крыши рисовался
    // ШИРЕ основания на 2px с каждой стороны (moveTo(x0-2,...)/
    // lineTo(x0+w+2,...)), чтобы карниз чуть свисал над стенами. Это
    // непрозрачная заливка, которая физически выходила за x0..x0+w —
    // ровно ту область, что isBuildPlacementValid/snapBuildingCenterToGrid
    // (02-utils-canvas.js) считают footprint здания на тайловой сетке.
    // Впритык поставленные соседние здания/стены визуально перекрывались
    // этим карнизом на 2px, хотя коллизия уже честно впритык. Теперь скат
    // укладывается РОВНО в границы x0+SI..x0+w-SI (тот же инсет, что и
    // основание выше) — силуэт остаётся тем же (треугольный конёк по
    // центру), просто без свеса за пределы клетки.
    ctx.fillStyle = darken(baseColor, 18);
    ctx.beginPath();
    ctx.moveTo(x0 + SI, y0 + h * 0.26);
    ctx.lineTo(s.x, y0);
    ctx.lineTo(x0 + w - SI, y0 + h * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
    ctx.stroke();
    // конёк крыши
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.moveTo(s.x, y0); ctx.lineTo(s.x, y0 + h * 0.26); ctx.stroke();
  } else if (type === "warFactory") {
    // низкий широкий грузовой блок с выступающим козырьком-навесом над
    // воротами (см. drawFactoryDetail) — приземистее и шире казарм.
    // Инсет по бокам — см. комментарий у barracks выше, тот же приём.
    ctx.fillStyle = grad;
    roundRect(x0 + SI, y0 + h * 0.1, w - SI * 2, h * 0.9 - SI, 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5;
    roundRect(x0 + SI, y0 + h * 0.1, w - SI * 2, h * 0.9 - SI, 2); ctx.stroke();

    // козырёк-навес над будущими воротами
    ctx.fillStyle = darken(baseColor, 15);
    ctx.fillRect(x0 + w * 0.15, y0 + h * 0.1 - 5, w * 0.7, 6);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + w * 0.15, y0 + h * 0.1 - 5, w * 0.7, 6);

    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
    const cols = Math.max(1, Math.round(w / 22));
    for (let i = 1; i < cols; i++) {
      const px = x0 + (w / cols) * i;
      ctx.beginPath(); ctx.moveTo(px, y0 + h * 0.16); ctx.lineTo(px, y0 + h - 3); ctx.stroke();
    }
  } else if (type === "airfield") {
    // длинная приземистая платформа с полосой ВПП по центру (контрастная
    // штрих-разметка) — единственное здание, где основной силуэт вытянут
    // по одной оси, а не квадратный блок. Инсет по бокам — та же причина.
    ctx.fillStyle = grad;
    roundRect(x0 + SI, y0 + h * 0.3, w - SI * 2, h * 0.7 - SI, 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5;
    roundRect(x0 + SI, y0 + h * 0.3, w - SI * 2, h * 0.7 - SI, 2); ctx.stroke();

    // диспетчерская вышка — маленький выступ в углу платформы
    ctx.fillStyle = darken(baseColor, 20);
    ctx.fillRect(x0 + w * 0.06, y0 + h * 0.05, w * 0.16, h * 0.3);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + w * 0.06, y0 + h * 0.05, w * 0.16, h * 0.3);

    // полоса ВПП — светлая дорожка с пунктирной осевой линией
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x0 + w * 0.28, y0 + h * 0.42, w * 0.66, h * 0.42);
    ctx.strokeStyle = "rgba(230,188,58,0.4)";
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x0 + w * 0.3, y0 + h * 0.63); ctx.lineTo(x0 + w * 0.92, y0 + h * 0.63); ctx.stroke();
    ctx.setLineDash([]);
  } else if (type === "turret") {
    // компактный круглый бункер вместо прямоугольной плиты — единственное
    // здание с круглым основанием, сразу отличимо на карте от всех прочих.
    // Радиус уже вписан внутрь min(w,h)/2 — дополнительно уменьшаем на SI,
    // чтобы обводка (lineWidth 1.5, центрируется на контуре) тоже не
    // выходила за вписанную окружность.
    const r = Math.min(w, h) / 2 - SI;
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x, s.y, r - 3, 0, Math.PI * 2); ctx.stroke();
  } else if (type === "refinery") {
    // ИИ №29: низкое прямоугольное основание + два вертикальных резервуара
    // (цистерны переработки) по бокам — силуэт сразу читается как
    // промышленно-добывающее здание, отличное от всех остальных. Инсет по
    // бокам основания — та же причина, что у barracks/warFactory/airfield.
    // Цистерны (tankW/tankX) намеренно НЕ инсечены — они уже вписаны
    // внутрь w с запасом (0.12w/0.88w от края), обводка там не достаёт до
    // границы footprint.
    ctx.fillStyle = grad;
    roundRect(x0 + SI, y0 + h * 0.35, w - SI * 2, h * 0.65 - SI, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5;
    roundRect(x0 + SI, y0 + h * 0.35, w - SI * 2, h * 0.65 - SI, 3); ctx.stroke();

    const tankW = w * 0.24, tankH = h * 0.62;
    [x0 + w * 0.12, x0 + w * 0.88 - tankW].forEach(tx => {
      const ty = y0 - tankH * 0.15;
      const tankGrad = ctx.createLinearGradient(0, ty, 0, ty + tankH);
      tankGrad.addColorStop(0, lighten(baseColor, 22));
      tankGrad.addColorStop(1, darken(baseColor, 18));
      ctx.fillStyle = tankGrad;
      roundRect(tx, ty, tankW, tankH, tankW * 0.4);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.2;
      roundRect(tx, ty, tankW, tankH, tankW * 0.4); ctx.stroke();
    });
  } else {
    // фолбэк — старое поведение (скруглённый прямоугольник + панельные
    // линии) для любого будущего типа здания без явного case выше.
    ctx.fillStyle = grad;
    roundRect(x0 + SI, y0 + SI, w - SI * 2, h - SI * 2, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1.5;
    roundRect(x0 + SI, y0 + SI, w - SI * 2, h - SI * 2, 3); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
    const cols = Math.max(1, Math.round(w / 22));
    for (let i = 1; i < cols; i++) {
      const px = x0 + (w / cols) * i;
      ctx.beginPath(); ctx.moveTo(px, y0 + 3); ctx.lineTo(px, y0 + h - 3); ctx.stroke();
    }
  }

  // акцентная окантовка по периметру — тонкая яркая рамка цвета роли здания
  // (см. BuildingAccent), нанесена ПОВЕРХ уже нарисованной формы, поэтому
  // работает для любого силуэта одинаково просто, не завязана на конкретный
  // contour каждого case выше.
  const accent = BuildingAccent[type];
  if (accent) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([w * 0.16, w * 0.09]);
    if (type === "turret") {
      ctx.beginPath(); ctx.arc(s.x, s.y, Math.min(w, h) / 2 - 1, 0, Math.PI * 2); ctx.stroke();
    } else {
      roundRect(x0 + 1.5, y0 + 1.5, w - 3, h - 3, 3);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawPowerPlantDetail(s, w, h, t) {
  // труба с поднимающимся дымком
  const chimneyX = s.x + w * 0.22, chimneyTop = s.y - h / 2 - 10;
  ctx.fillStyle = "rgba(40,40,38,0.9)";
  ctx.fillRect(chimneyX - 4, chimneyTop, 8, h / 2 + 10);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.strokeRect(chimneyX - 4, chimneyTop, 8, h / 2 + 10);

  for (let i = 0; i < 3; i++) {
    const puffT = (t / 900 + i / 3) % 1;
    const py = chimneyTop - puffT * 26;
    const alpha = (1 - puffT) * 0.35;
    if (alpha <= 0.01) continue;
    ctx.fillStyle = `rgba(180,180,175,${alpha})`;
    ctx.beginPath();
    ctx.arc(chimneyX + Math.sin(puffT * 6) * 3, py, 3 + puffT * 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // энергетическая катушка/ядро с пульсацией
  const coreR = 5 + Math.sin(t / 300) * 1;
  const glow = ctx.createRadialGradient(s.x - w * 0.18, s.y, 1, s.x - w * 0.18, s.y, coreR * 2.4);
  glow.addColorStop(0, "rgba(120,220,255,0.9)");
  glow.addColorStop(1, "rgba(120,220,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(s.x - w * 0.18, s.y, coreR * 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#cdefff";
  ctx.beginPath(); ctx.arc(s.x - w * 0.18, s.y, coreR, 0, Math.PI * 2); ctx.fill();
}

// ИИ №29: деталь-анимация для refinery — маленький качающийся насос-качалка
// по центру между резервуарами (drawBuildingShape), плюс редкие искры-точки
// "добычи", поднимающиеся вверх — тот же визуальный язык, что дымок у
// powerPlant (drawPowerPlantDetail), но по смыслу это "идёт добыча", а не
// "вырабатывается энергия".
function drawRefineryDetail(s, w, h, t) {
  const pumpPhase = Math.sin(t / 450);
  const armY = s.y - h * 0.06 + pumpPhase * 2.5;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y - h * 0.1);
  ctx.lineTo(s.x, armY);
  ctx.stroke();
  ctx.fillStyle = "#2a2420";
  ctx.beginPath(); ctx.arc(s.x, armY, 3, 0, Math.PI * 2); ctx.fill();

  for (let i = 0; i < 2; i++) {
    const puffT = (t / 1100 + i / 2) % 1;
    const py = s.y - h * 0.15 - puffT * 20;
    const alpha = (1 - puffT) * 0.5;
    if (alpha <= 0.01) continue;
    ctx.fillStyle = `rgba(224,166,74,${alpha})`;
    ctx.beginPath();
    ctx.arc(s.x + (i === 0 ? -w * 0.14 : w * 0.14), py, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTurretDetail(b, s, t) {
  // вращающаяся башенка со стволом — целится в текущую цель, иначе крутится
  // медленным "патрульным" сканом
  let angle;
  const target = b.attackTargetId ? findAttackableAt(b.attackTargetId) : null;
  if (target && dist(b.x, b.y, target.x, target.y) > 4) {
    angle = Math.atan2(target.y - b.y, target.x - b.x);
  } else if (target) {
    angle = visState(b).angle;
  } else {
    angle = t / 1400;
  }
  const vis = visState(b);
  // ИИ №28: сглаживание замедлено по прямому запросу пользователя
  // ("анимация передвижения станет плавнее и медленее") — было 0.15,
  // теперь 0.07. Та же логика нормализации угла (normalizeAngleDiff),
  // просто более длинная "инерция" поворота башни турели-здания.
  vis.angle += normalizeAngleDiff(angle - vis.angle) * 0.07;

  ctx.save();
  ctx.translate(s.x, s.y);
  // база башни
  ctx.fillStyle = "rgba(20,20,18,0.9)";
  ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();

  ctx.rotate(vis.angle);
  ctx.fillStyle = "#2a2a26";
  ctx.fillRect(0, -2.5, 16, 5);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.strokeRect(0, -2.5, 16, 5);

  // дульная вспышка сразу после выстрела (используем attackCooldownLeft
  // как индикатор "только что выстрелил": кулдаун только что стал полным)
  const def = BuildingDefs[b.type];
  if (def && b.attackCooldownLeft > def.attackCooldown - 90) {
    ctx.fillStyle = "rgba(255,220,140,0.95)";
    ctx.beginPath(); ctx.arc(17, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ctx.arc(17, 0, 2, 0, Math.PI * 2); ctx.fill();
    if (target) {
      const muzzleWorld = { x: b.x + Math.cos(vis.angle) * 17, y: b.y + Math.sin(vis.angle) * 17 };
      maybeSpawnShotProjectile(vis, muzzleWorld.x, muzzleWorld.y, target.x, target.y, "bullet", b.attackCooldownLeft);
    }
  }
  ctx.restore();
}

function drawFactoryDetail(s, w, h, def) {
  // большие ворота ангара по центру нижней грани
  const gateW = w * 0.4;
  ctx.fillStyle = "rgba(10,10,9,0.85)";
  ctx.fillRect(s.x - gateW / 2, s.y + h / 2 - 10, gateW, 10);
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.strokeRect(s.x - gateW / 2, s.y + h / 2 - 10, gateW, 10);
  ctx.strokeStyle = "rgba(230,188,58,0.35)";
  ctx.beginPath(); ctx.moveTo(s.x, s.y + h / 2 - 10); ctx.lineTo(s.x, s.y + h / 2); ctx.stroke();
}

function drawCommandCenterDetail(s, w, h, t) {
  // антенна с мигающим маячком — штаб всегда должен читаться на карте
  const antX = s.x, antTopY = s.y - h / 2 - 14;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(antX, s.y - h / 2 + 2); ctx.lineTo(antX, antTopY); ctx.stroke();
  const blink = Math.sin(t / 260) > 0;
  ctx.fillStyle = blink ? "#ff5a4a" : "rgba(120,40,30,0.5)";
  if (blink) { ctx.shadowColor = "#ff5a4a"; ctx.shadowBlur = 6; }
  ctx.beginPath(); ctx.arc(antX, antTopY, 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // флаг/значок фракции по центру
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath(); ctx.arc(s.x, s.y, w * 0.16, 0, Math.PI * 2); ctx.fill();
}

// Горящее здание — 2-3 очага пламени (детерминированные по id здания точки
// на площади крыши, не Math.random каждый кадр — иначе огонь будет
// телепортироваться по зданию каждый рендер) с поднимающимся дымом. Ниже
// 25% HP дым гуще и темнее — читается как "вот-вот падёт", не только цветом
// hp-бара, но и самим пожаром.
function drawBuildingFire(b, s, w, h, t) {
  const critical = b.hp < b.maxHp * 0.25;
  // детерминированные точки очагов — по хэшу id здания, стабильны между кадрами
  const seed = (b.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % 1000;
  const spots = critical ? 3 : 2;
  for (let i = 0; i < spots; i++) {
    const fx = s.x + ((seed * (i + 3)) % 100 - 50) / 100 * w * 0.55;
    const fy = s.y + ((seed * (i + 7)) % 100 - 50) / 100 * h * 0.5;
    const flick = 0.7 + Math.sin(t / (110 + i * 37) + i * 5) * 0.3;

    // языки пламени — пара наслаивающихся треугольных бликов, мерцающих по фазе
    ctx.save();
    ctx.translate(fx, fy);
    const flameH = (critical ? 11 : 7) * flick;
    const grad = ctx.createLinearGradient(0, 2, 0, -flameH);
    grad.addColorStop(0, "rgba(255,140,40,0.9)");
    grad.addColorStop(0.6, "rgba(255,90,30,0.7)");
    grad.addColorStop(1, "rgba(255,200,60,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-3, 2); ctx.quadraticCurveTo(-4, -flameH * 0.5, 0, -flameH);
    ctx.quadraticCurveTo(4, -flameH * 0.5, 3, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // дым — 3 поднимающихся клуба на цикле ~1.4с, шире и темнее в critical
    for (let k = 0; k < 3; k++) {
      const puffT = ((t / 1400 + k / 3 + i * 0.2) % 1);
      const py = fy - puffT * (critical ? 34 : 22) - 4;
      const alpha = (1 - puffT) * (critical ? 0.4 : 0.24);
      if (alpha <= 0.01) continue;
      ctx.fillStyle = critical ? `rgba(40,36,32,${alpha})` : `rgba(70,66,60,${alpha})`;
      ctx.beginPath();
      ctx.arc(fx + Math.sin(puffT * 5 + i) * 4, py, (critical ? 4 : 2.5) + puffT * (critical ? 8 : 5), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ================================================================
   ЮНИТЫ
   ================================================================ */
function drawUnit(u, t) {
  const udef = UnitDefs[u.type];
  if (!udef) return;
  const vis = visState(u);
  updateHitFlash(u, vis);

  const s = worldToScreen(u.x, u.y);
  if (s.x < -24 || s.y < -24 || s.x > visibleWorldWidth() + 24 || s.y > visibleWorldHeight() + 24) return;

  const player = State.players[u.ownerId];
  const baseColor = player ? player.color : "#fff";

  // ориентация: к цели атаки, иначе по вектору движения, иначе сохраняем
  // прошлый угол (юнит стоит и смотрит туда же, куда смотрел)
  let desiredAngle = vis.targetAngle;
  const attackTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
  if (attackTarget) {
    if (dist(u.x, u.y, attackTarget.x, attackTarget.y) > 4) {
      desiredAngle = Math.atan2(attackTarget.y - u.y, attackTarget.x - u.x);
    }
  } else if (u.targetX != null && (u.state === "moving" || u.state === "moving-to-harvest" || u.state === "returning")) {
    // ИИ №18/19 (СТАРЫЕ БАГФИКСЫ, см. историю в git/PROMPT — вкратце: №18
    // поднял порог до >4px против суб-пиксельного шума координат; №19
    // переключил прицел с ближайшего waypoint на КОНЕЧНУЮ точку пути
    // (u.pathGoalX/Y), чтобы убрать зигзаг-дрожь на стыках сегментов
    // A*-сетки).
    //
    // ИИ №24: БАГФИКС #3 — №19 убрал дрожь, но создал более заметный баг:
    // "юнит смотрит на точку, которую я поставил, а не в сторону
    // движения" — особенно видно при обходе здания. Причина: pathGoalX/Y
    // это координаты КОНЕЧНОГО приказа, а не текущее направление. Когда
    // маршрут огибает постройку, луч от юнита до pathGoal физически
    // проходит СКВОЗЬ эту постройку — визуально юнит "смотрит в стену"
    // вместо того чтобы смотреть туда, куда реально идёт (в сторону, в
    // обход). Статичная точка-цель (будь то waypoint или pathGoal) в
    // принципе не может отражать обход препятствия, потому что обход —
    // это свойство ТРАЕКТОРИИ, а не координата одной точки.
    //
    // Фикс: ориентируемся по фактическому вектору перемещения между
    // соседними отрисованными кадрами (vis.lastMoveX/Y -> u.x/u.y). Это
    // всегда совпадает с реальным направлением хода юнита, включая обход
    // зданий — при повороте маршрута вектор кадр-к-кадру плавно меняется
    // вместе с фактической траекторией, а не скачет между waypoint'ами и
    // не тычет сквозь стены на pathGoal. Мелкая покадровая дрожь вектора
    // (суб-пиксельный шум) гасится тем же сглаживанием vis.angle
    // (+= diff*0.22), что и раньше — отдельный порог по dist здесь не
    // нужен, порог остаётся только как защита от деления на ~0 при
    // полностью неподвижном юните.
    const moveDx = u.x - vis.lastMoveX;
    const moveDy = u.y - vis.lastMoveY;
    if (Math.hypot(moveDx, moveDy) > 0.05) {
      desiredAngle = Math.atan2(moveDy, moveDx);
    }
  }
  vis.targetAngle = desiredAngle;
  // ИИ №28: было 0.22 — по прямому запросу пользователя ("анимация
  // передвижения станет плавнее и медленее") корпус юнита теперь
  // доворачивается к desiredAngle заметно медленнее. Не трогаю
  // remainder логики (moveDx/moveDy, порог >0.05) — только скорость
  // сглаживания самого угла.
  vis.angle += normalizeAngleDiff(desiredAngle - vis.angle) * 0.10;
  // Фиксируем позицию ЭТОГО кадра как точку отсчёта для вектора движения
  // в СЛЕДУЮЩЕМ кадре (см. блок desiredAngle выше, ИИ №24).
  vis.lastMoveX = u.x;
  vis.lastMoveY = u.y;

  // появление
  const spawnAge = t - vis.spawnT;
  const spawnScale = spawnAge < 220 ? 0.5 + 0.5 * easeOutBack(Math.min(1, spawnAge / 220)) : 1;

  // лёгкое "дыхание" стоящих юнитов, чтобы карта не выглядела статичной
  // ИИ №29: state "harvesting" убран вместе с юнитом worker.
  const idleBob = (u.state === "idle") ? Math.sin(t / 500 + vis.bob) * 1 : 0;

  ctx.save();
  ctx.translate(s.x, s.y + idleBob);
  ctx.scale(spawnScale, spawnScale);

  if (u.type === "gunship") {
    // ИИ №34: gunship — ВТОРОЙ flying-юнит, отдельная функция ДО общей
    // ветки udef.flying (иначе попал бы в drawAircraft и рисовался бы
    // неотличимо от истребителя). Проверка идёт раньше udef.flying именно
    // по типу, а не наоборот, чтобы не плодить доп. флаг в UnitDefs ради
    // одной развилки рендера.
    drawGunship(u, udef, baseColor, vis, t);
  } else if (udef.flying) {
    drawAircraft(u, udef, baseColor, vis, t);
  } else if (u.type === "tank" || u.type === "heavyTank") {
    // ИИ №22: heavyTank переиспользует drawTank — та же силуэтная схема
    // (гусеницы+корпус+независимо целящаяся башня), масштаб идёт от
    // udef.bodyRadius (уже больше у heavyTank), отдельная функция не нужна.
    drawTank(u, udef, baseColor, vis, t);
  } else if (u.type === "apc") {
    // ИИ (визуал): apc раньше молча падал в drawInfantry (дефолтная ветка) —
    // рисовался как пехотинец с пистолетом, хотя это колёсная техника с
    // bodyRadius=18. Отдельный силуэт: колёса вместо гусениц, лёгкий корпус
    // БЕЗ отдельно вращающейся башни (в отличие от tank/heavyTank — короткий
    // курсовой пулемёт жёстко смотрит по корпусу, это дешёвая ранняя техника,
    // не полноценный танк).
    drawApc(u, udef, baseColor, vis, t);
  } else if (u.type === "artillery") {
    // ИИ №34: artillery — дальнобойная САУ, отдельный силуэт (см.
    // drawArtillery ниже) — длинный ствол-хобот, читается издалека как
    // "это бьёт по площади", не спутать с обычным tank.
    drawArtillery(u, udef, baseColor, vis, t);
  } else {
    drawInfantry(u, udef, baseColor, vis, t); // rifleman / rocketeer / grenadier / sniper / sapper / фолбэк
  }

  // вспышка попадания
  const sinceHit = t - vis.hitFlashT;
  if (sinceHit < 160) {
    ctx.save();
    ctx.globalAlpha = (1 - sinceHit / 160) * 0.85;
    ctx.fillStyle = "#fff";
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath(); ctx.arc(0, 0, (udef.bodyRadius || 10) + 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // translate/scale

  // HP bar и выделение — в мировых (не повёрнутых) координатах
  if (u.hp < u.maxHp - 0.5 || State.selection.has(u.id)) {
    drawHpBar(s.x - 10, s.y - (udef.bodyRadius || 10) - 8, 20, u.hp, u.maxHp);
  }

  if (State.selection.has(u.id)) {
    drawSelectionRingAnimated(s.x, s.y, (udef.bodyRadius || 10) + 3, t);
    if (u.attackTargetId) {
      const tgt = findAttackableAt(u.attackTargetId);
      if (tgt) drawAttackTracer(s.x, s.y, tgt, t);
    }
  }
}

// Пехота (rifleman/rocketeer/grenadier/sniper): каска сверху, торс, оружие в
// направлении взгляда. rocketeer чуть шире в плечах (труба ПТУР), grenadier
// (ИИ №22, тяжёлая пехота) — короткий толстый ствол гранатомёта с барабаном
// снизу. sniper (ИИ визуал, ранее молча падал в фолбэк-ветку с силуэтом
// rifleman) — длинная тонкая винтовка ЗАМЕТНО длиннее любого другого оружия
// пехоты, складные сошки под стволом, оптический прицел бликует линзой,
// плоский маскировочный капюшон вместо каски. Держим пехоту визуально
// компактной группой в целом — различия читаются по форме оружия/головного
// убора, не по размеру тела.
// ИИ (визуал, переработка №2): предыдущая версия ("нога-эллипсы + плечи-
// эллипс + круглый торс поверх") на деле всё ещё читалась как кружок —
// торс был самым крупным элементом и рисовался ПОСЛЕДНИМ, перекрывая
// плечи почти целиком, а оружие было тонкой одноцветной линией без объёма.
// Теперь фигура строится по-другому и в другом порядке:
//  - плечи — не эллипс, а ШЕСТИУГОЛЬНАЯ "жилетка" (угловатый top-down
//    силуэт бронежилета/разгрузки, шире в плечах и сужается к талии) —
//    рисуется ПОСЛЕДНЕЙ (поверх головы-капсулы), поэтому именно она, а не
//    круглый торс, определяет итоговый видимый силуэт;
//  - голова — маленький отдельный кружок СМЕЩЁННЫЙ к "затылку" (назад от
//    направления взгляда), не по центру фигуры — так плечи спереди читаются
//    шире головы, как и должно быть у человека сверху;
//  - оружие каждого типа — законченная многодетальная форма (приклад +
//    ствол + характерный элемент), а не один прямоугольник переменной
//    толщины: rifleman — узкий ствол+короткий приклад+рукоятка, rocketeer —
//    труба ПТУР с раструбом и прицельной планкой, grenadier — толстый
//    гранатомёт с барабаном И прикладом, sniper — длинный ствол+сошки+
//    оптика (как раньше, уже хорошо читался).
// ИИ (визуал, переработка №3 — по прямому фидбеку "правки не заметны"):
// проблема была не в геометрии контура, а в том, что все 4 типа пехоты
// делили один и тот же масштаб r, одну и ту же позу и один и тот же
// приглушённый цвет обвеса (только оттенки baseColor) — на маленьком
// спрайте это read'ится как "одна и та же фигура с разной палкой". Теперь
// различия форсированы по нескольким независимым осям одновременно:
//  - МАСШТАБ ТЕЛА: sniper заметно ХУДЕЕ/мельче (0.82×), grenadier заметно
//    КРУПНЕЕ/тяжелее (1.22×) — даже издалека, до всякой детализации оружия,
//    видно "это разные юниты", не только на приближении.
//  - ПОЗА: sniper идёт присев (голова и плечи ниже, силуэт площе), grenadier
//    стоит враскоряку (stanceY шире даже в покое — тяжёлая экипировка),
//    rocketeer держит трубу на плече заметно СМЕЩЁННОЙ вбок (не по оси
//    тела, как остальные) — труба ПТУР физически лежит на плече сбоку.
//  - ЦВЕТ: у каждого типа акцентный (не производный от baseColor) цвет
//    снаряжения — sniper: тускло-оливковый маскхалат, grenadier: ржаво-
//    коричневый бронежилет, rocketeer: серо-стальной ранец с трубами на
//    спине, rifleman: нейтральный тёмный (baseColor остаётся ведущим).
function drawInfantry(u, udef, baseColor, vis, t) {
  const isRocketeer = u.type === "rocketeer";
  const isGrenadier = u.type === "grenadier";
  const isSniper = u.type === "sniper";
  // ИИ №34: sapper — коренастый, но не крупный (0.92×, между sniper 0.82
  // и rifleman 1.0) — визуально "собранный, налегке", в отличие от
  // тяжеловесного grenadier (1.22×).
  const isSapper = u.type === "sapper";
  const scale = isGrenadier ? 1.22 : (isSniper ? 0.82 : (isRocketeer ? 1.05 : (isSapper ? 0.92 : 1)));
  const r = (udef.bodyRadius ? udef.bodyRadius * 0.62 : 7) * scale;

  // тень — крупнее у grenadier (тяжелее), приплюснута у sniper (пригнут)
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(0, r * 0.9, r * 1.15, r * (isSniper ? 0.62 : 0.5), 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  const isMoving = (u.state === "moving" || u.state === "moving-to-harvest" || u.state === "returning");
  const stepPhase = isMoving ? Math.sin(t / 80 + vis.bob) : 0;

  // ноги — ИИ (фикс №2 по фидбеку "ноги как задница, тверкают"): предыдущая
  // версия держала ноги ПОСТОЯННО торчащими за спиной и разводила их В
  // СТОРОНЫ (по Y) при движении — то есть визуально это было "виляние
  // бёдрами вбок", а не шаг. Настоящий шаг — это чередование ног ВДОЛЬ оси
  // движения (по X): нога то выдвигается вперёд из-под корпуса, то
  // уезжает назад, а не расходится по бокам. Механика теперь:
  //  - centerX = -r*0.15 — ноги стоят ПОД корпусом (почти у центра, чуть
  //    ближе к спине), в покое почти целиком скрыты жилеткой сверху;
  //  - каждая нога сдвигается по X на величину её собственной фазы шага
  //    (нога A и нога B в противофазе — classic "left-right-left-right"),
  //    амплитуда обнуляется в покое (stepPhase=0 когда не isMoving), так что
  //    стоя на месте ноги полностью прячутся под жилеткой и не торчат;
  //  - небольшое фиксированное разведение по Y (stanceY) остаётся, но оно
  //    МАЛО и не пульсирует — это просто "ширина стойки", не источник
  //    виляния; у sniper она минимальна (сведены), у grenadier чуть шире
  //    (устойчивая стойка), но не анимируется.
  const legLen = r * 0.85, legW = r * (isGrenadier ? 0.18 : 0.7);
  const legAmp = isMoving ? legLen * 1.0 : 0; // амплитуда хода вперёд/назад по X
  const centerX = -r * 0.05;
  const stanceY = r * (isGrenadier ? 0.22 : (isSniper ? 0.1 : 0.16));
  ctx.save();
  ctx.rotate(vis.angle);
  ctx.fillStyle = darken(baseColor, 38);
  const legAX = centerX + stepPhase * legAmp;
  const legBX = centerX - stepPhase * legAmp;
  ctx.beginPath(); ctx.ellipse(legAX, -stanceY, legW, legLen * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(legBX, stanceY, legW, legLen * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  // тёмная стопа на переднем/заднем конце ноги (в сторону хода, не назад
  // фиксированно) — читается как ботинок в момент шага вперёд
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath(); ctx.ellipse(legAX + Math.sign(stepPhase || 1) * legLen * 0.18, -stanceY, legW * 0.8, legLen * 0.16, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(legBX - Math.sign(stepPhase || 1) * legLen * 0.18, stanceY, legW * 0.8, legLen * 0.16, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // rocketeer: ранец с запасными трубами на спине — рисуется ДО плеч, торчит
  // из-за спины по бокам, сразу даёт узнаваемый "вьючный" силуэт даже без
  // взгляда на само оружие в руках
  if (isRocketeer) {
    ctx.save();
    ctx.rotate(vis.angle);
    ctx.fillStyle = "#5a5f5c";
    ctx.fillRect(-r * 1.05, -r * 0.55, r * 0.5, r * 0.35);
    ctx.fillRect(-r * 1.05, r * 0.2, r * 0.5, r * 0.35);
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 0.6;
    ctx.strokeRect(-r * 1.05, -r * 0.55, r * 0.5, r * 0.35);
    ctx.strokeRect(-r * 1.05, r * 0.2, r * 0.5, r * 0.35);
    ctx.restore();
  }

  // оружие
  ctx.save();
  ctx.rotate(vis.angle);
  const weap = drawInfantryWeapon(u, udef, isRocketeer, isGrenadier, isSniper, isSapper, r, t);

  // дульная вспышка + снаряд-трассер — та же логика, что была раньше,
  // возвращена и синхронизирована с новой геометрией оружия (muzzleX
  // теперь приходит из drawInfantryWeapon, а не пересчитывается вручную)
  if (u.attackCooldownLeft > 0) {
    const cdMax = udef.attackCooldown || 1;
    const flashWindow = isSniper ? 60 : (isSapper ? 110 : 80);
    if (u.attackCooldownLeft > cdMax - flashWindow) {
      // ИИ №34: sapper — крупная тёплая вспышка подрыва в упор (не тонкий
      // выстрел) — читается как взрыв заряда, а не выстрел из ствола.
      ctx.fillStyle = isSapper ? "rgba(255,180,90,0.95)" : (isSniper ? "rgba(255,240,200,0.95)" : "rgba(255,220,140,0.9)");
      ctx.beginPath(); ctx.arc(weap.muzzleX, 0, isSapper ? 6 : (isSniper ? 4.5 : (isGrenadier ? 4 : (isRocketeer ? 3.5 : 2.4))), 0, Math.PI * 2); ctx.fill();
      if (isSniper) {
        ctx.strokeStyle = "rgba(255,240,200,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(weap.muzzleX, 0); ctx.lineTo(weap.muzzleX + 6, 0); ctx.stroke();
      }
    }
    const shotTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    // ИИ №34: sapper бьёт вплотную (attackRange:40) — трассер-снаряд на
    // таком расстоянии визуально бесполезен (пролетает кадр-другой), не
    // спавним projectile для него, только вспышка выше уже продаёт удар.
    if (shotTarget && !isSapper) {
      const muzzleWorld = { x: u.x + Math.cos(vis.angle) * weap.muzzleX, y: u.y + Math.sin(vis.angle) * weap.muzzleX };
      const projKind = (isRocketeer || isGrenadier) ? "rocket" : "bullet";
      maybeSpawnShotProjectile(vis, muzzleWorld.x, muzzleWorld.y, shotTarget.x, shotTarget.y, projKind, u.attackCooldownLeft);
    }
  }
  ctx.restore();

  // голова — смещена назад, у sniper дополнительно "утоплена" ниже (пригнут)
  ctx.save();
  ctx.rotate(vis.angle);
  const headY = isSniper ? r * 0.08 : 0;
  ctx.fillStyle = darken(baseColor, 30);
  ctx.beginPath(); ctx.arc(-r * 0.28, headY, r * 0.44, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.7; ctx.stroke();
  ctx.fillStyle = isSniper ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.22)";
  ctx.beginPath(); ctx.ellipse(-r * 0.05, headY, r * 0.22, r * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // плечи/жилетка — угловатый силуэт, цвет акцента зависит от типа вместо
  // единого производного от baseColor тона: это самый заметный на глаз
  // читаемый признак "это другой юнит", даже раньше, чем форма оружия.
  ctx.save();
  ctx.rotate(vis.angle);
  let vestBase = baseColor;
  if (isSniper) vestBase = "#5c5f42";       // тускло-оливковый маскхалат
  else if (isGrenadier) vestBase = "#6b4a34"; // ржаво-коричневый бронежилет
  else if (isRocketeer) vestBase = "#565b5e"; // серо-стальной обвес
  else if (isSapper) vestBase = "#8a6a2a";  // ИИ №34: тускло-жёлто-коричневый — сапёрная разгрузка с подсумками зарядов

  const shGrad = ctx.createLinearGradient(0, -r, 0, r);
  shGrad.addColorStop(0, lighten(vestBase, 20));
  shGrad.addColorStop(1, darken(vestBase, 18));
  ctx.fillStyle = shGrad;
  ctx.beginPath();
  ctx.moveTo(r * 0.9, 0);
  ctx.lineTo(r * 0.35, -r * 0.85);
  ctx.lineTo(-r * 0.55, -r * 0.62);
  ctx.lineTo(-r * 0.72, 0);
  ctx.lineTo(-r * 0.55, r * 0.62);
  ctx.lineTo(r * 0.35, r * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1; ctx.stroke();

  // тонкий кант цвета фракции (baseColor) поверх акцентного жилета — держит
  // визуальную связь "это мой/вражеский юнит" даже когда сам жилет цветной
  ctx.strokeStyle = baseColor; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.moveTo(r * 0.35, -r * 0.85); ctx.lineTo(r * 0.9, 0); ctx.lineTo(r * 0.35, r * 0.85); ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(r * 0.6, 0); ctx.lineTo(-r * 0.4, 0); ctx.stroke();

  if (isGrenadier) {
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.beginPath();
    ctx.moveTo(r * 0.55, -r * 0.5); ctx.lineTo(r * 0.2, -r * 0.72);
    ctx.lineTo(-r * 0.3, -r * 0.5); ctx.lineTo(-r * 0.3, r * 0.5);
    ctx.lineTo(r * 0.2, r * 0.72); ctx.lineTo(r * 0.55, r * 0.5);
    ctx.closePath(); ctx.fill();
    // диагональные ремни подсумков — доп. деталь, читается как "обвешан снаряжением"
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r * 0.3, -r * 0.6); ctx.lineTo(-r * 0.5, r * 0.3); ctx.stroke();
  }
  if (isSniper) {
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1.2;
    [-0.5, -0.15, 0.2, 0.55].forEach(off => {
      ctx.beginPath(); ctx.moveTo(r * off, -r * 0.8); ctx.lineTo(r * (off - 0.15), r * 0.8); ctx.stroke();
    });
  }
  if (isSapper) {
    // ИИ №34: связка брусков взрывчатки на груди — короткие тёмные
    // прямоугольники в ряд с тонкой красной "предохранительной" полосой,
    // главный узнаваемый силуэтный элемент сапёра (аналог барабана
    // grenadier/оптики sniper).
    ctx.fillStyle = "rgba(20,18,14,0.75)";
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(r * 0.05, -r * 0.42 + i * r * 0.3, r * 0.42, r * 0.22);
    }
    ctx.strokeStyle = "rgba(200,50,40,0.6)"; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(r * 0.05, -r * 0.42); ctx.lineTo(r * 0.05, r * 0.1); ctx.stroke();
  }
  ctx.restore();
}

// Оружие пехоты — законченная многодетальная форма от кисти (~r*0.15 от
// центра) вперёд, а не один прямоугольник переменной толщины. Вызывается
// уже внутри повёрнутого (vis.angle) контекста из drawInfantry.
function drawInfantryWeapon(u, udef, isRocketeer, isGrenadier, isSniper, isSapper, r, t) {
  const dark = "#232420", mid = "#3a3a34", wood = "#5a4632";

  if (isSapper) {
    // ИИ №34: заряд взрывчатки в вытянутых руках вместо ствола — короткий
    // толстый брусок с мигающим красным детонатором на конце, никакого
    // "оружия дальнего боя" — сразу читается как "он бежит его подложить",
    // а не стреляет. Заметно короче любого другого оружия пехоты (муzzle
    // близко к телу — соответствует attackRange:40, самому короткому в игре).
    const len = r * 0.75;
    ctx.fillStyle = dark;
    ctx.fillRect(-r * 0.05, -2.4, r * 0.3, 4.8); // рукоятка/держатель
    ctx.fillStyle = "#4a3a1e";
    ctx.fillRect(r * 0.2, -3, len, 6);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.6;
    ctx.strokeRect(r * 0.2, -3, len, 6);
    // мигающий детонатор на конце — частый пульс, читается как "взведено"
    const blink = 0.4 + Math.sin(t / 120) * 0.35;
    ctx.fillStyle = `rgba(255,60,40,${Math.max(0.2, blink)})`;
    ctx.beginPath(); ctx.arc(r * 0.2 + len, 0, 1.6, 0, Math.PI * 2); ctx.fill();
    return { muzzleX: r * 0.2 + len, gunLen: r * 0.2 + len };
  }

  if (isSniper) {
    // длинная тонкая винтовка: приклад-плита у плеча, тонкий ствол далеко
    // вперёд, складные сошки, оптика с бликом
    const len = r * 2.6;
    ctx.fillStyle = wood;
    ctx.fillRect(r * 0.1, -1.6, r * 0.5, 3.2); // приклад
    ctx.fillStyle = dark;
    ctx.fillRect(r * 0.5, -0.9, len, 1.8); // ствол
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.5;
    ctx.strokeRect(r * 0.5, -0.9, len, 1.8);
    // сошки
    ctx.strokeStyle = dark; ctx.lineWidth = 1;
    const bx = r * 0.5 + len * 0.55;
    ctx.beginPath(); ctx.moveTo(bx, 0.9); ctx.lineTo(bx - 2, 4.2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx, 0.9); ctx.lineTo(bx + 2, 4.2); ctx.stroke();
    // оптика
    ctx.fillStyle = dark;
    ctx.fillRect(r * 0.7, -2.6, 6, 1.6);
    const glint = 0.4 + Math.sin(t / 260) * 0.25;
    ctx.fillStyle = `rgba(140,220,255,${glint})`;
    ctx.beginPath(); ctx.arc(r * 0.7 + 5.5, -1.8, 0.9, 0, Math.PI * 2); ctx.fill();
    return { muzzleX: r * 0.5 + len, gunLen: r * 0.5 + len };
  }

  if (isRocketeer) {
    // труба ПТУР — толстая труба с раструбом-воронкой на конце и прицельной
    // планкой сверху, короче сошки не нужны, оружие держится с плеча
    const len = r * 1.5;
    ctx.fillStyle = mid;
    ctx.fillRect(r * 0.15, -3.2, len, 6.4);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.6;
    ctx.strokeRect(r * 0.15, -3.2, len, 6.4);
    // раструб на конце — расширяющаяся воронка
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(r * 0.15 + len, -3.2);
    ctx.lineTo(r * 0.15 + len + 3, -4.4);
    ctx.lineTo(r * 0.15 + len + 3, 4.4);
    ctx.lineTo(r * 0.15 + len, 3.2);
    ctx.closePath(); ctx.fill();
    // прицельная планка сверху
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(r * 0.4, -4.4, len * 0.4, 1.2);
    return { muzzleX: r * 0.15 + len + 3, gunLen: r * 0.15 + len + 3 };
  }

  if (isGrenadier) {
    // короткий толстый гранатомёт: массивный ствол + приклад + характерный
    // барабан-магазин снизу (главный узнаваемый элемент)
    const len = r * 1.1;
    ctx.fillStyle = wood;
    ctx.fillRect(-r * 0.1, -2.2, r * 0.35, 4.4); // приклад
    ctx.fillStyle = mid;
    ctx.fillRect(r * 0.2, -3.4, len, 6.8);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.6;
    ctx.strokeRect(r * 0.2, -3.4, len, 6.8);
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.arc(r * 0.2 + len * 0.35, 4.6, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 0.6; ctx.stroke();
    return { muzzleX: r * 0.2 + len, gunLen: r * 0.2 + len };
  }

  // rifleman (фолбэк) — узкий автомат: приклад, магазин под углом, короткий ствол
  const len = r * 1.35;
  ctx.fillStyle = wood;
  ctx.fillRect(-r * 0.05, -1.3, r * 0.35, 2.6); // приклад
  ctx.fillStyle = dark;
  ctx.fillRect(r * 0.25, -1.1, len, 2.2);
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.5;
  ctx.strokeRect(r * 0.25, -1.1, len, 2.2);
  // магазин — скошенный вниз-назад параллелограмм
  ctx.fillStyle = "#1e1e1a";
  ctx.beginPath();
  ctx.moveTo(r * 0.55, 1.1); ctx.lineTo(r * 0.75, 1.1);
  ctx.lineTo(r * 0.65, 5.2); ctx.lineTo(r * 0.48, 5.2);
  ctx.closePath(); ctx.fill();
  return { muzzleX: r * 0.25 + len, gunLen: r * 0.25 + len };
}

// ИИ №29: drawWorker() удалена — юнит worker убран (см. UnitDefs, 01-config-state.js).

function drawTank(u, udef, baseColor, vis, t) {
  const isHeavy = u.type === "heavyTank";
  const r = udef.bodyRadius || 22;
  const bodyW = r * 1.5, bodyH = r * 1.05;

  // след гусениц — регистрируется не чаще раза в ~140мс на юнит (throttle
  // через vis, иначе движущаяся толпа техники завалит FX.tracks за секунды)
  if ((u.state === "moving" || u.state === "returning" || u.state === "moving-to-harvest") && (!vis.lastTrackT || t - vis.lastTrackT > 140)) {
    vis.lastTrackT = t;
    FX.tracks.push({ x: u.x, y: u.y, angle: vis.angle, t0: t, w: bodyW * 0.75 });
  }

  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(0, bodyH * 0.55, bodyW * 0.62, bodyH * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // корпус ориентирован по направлению движения
  ctx.save();
  ctx.rotate(vis.angle);

  // гусеницы
  ctx.fillStyle = "#141412";
  ctx.fillRect(-bodyW / 2, -bodyH / 2 - 3, bodyW, 4);
  ctx.fillRect(-bodyW / 2, bodyH / 2 - 1, bodyW, 4);

  // корпус
  const grad = cachedLinearGradient(0, -bodyH / 2, 0, bodyH / 2, lighten(baseColor, 15), darken(baseColor, 25), "tank|" + baseColor + "|" + bodyH);
  ctx.fillStyle = grad;
  roundRectLocal(-bodyW / 2, -bodyH / 2, bodyW, bodyH, 3);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1.2; ctx.stroke();

  // ИИ №22: доп. рифлёные бронеплиты по бокам корпуса — только у heavyTank,
  // визуально сигнализируют "тяжелее обычного tank" ещё до сравнения размера.
  if (isHeavy) {
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(-bodyW / 2 + 2, -bodyH / 2 + 2, bodyW * 0.18, bodyH - 4);
    ctx.fillRect(bodyW / 2 - 2 - bodyW * 0.18, -bodyH / 2 + 2, bodyW * 0.18, bodyH - 4);
  }
  ctx.restore();

  // башня — целится независимо от корпуса
  let turretAngle = vis.angle;
  const target = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
  if (target && dist(u.x, u.y, target.x, target.y) > 4) turretAngle = Math.atan2(target.y - u.y, target.x - u.x);
  if (vis.turretAngle == null) vis.turretAngle = turretAngle;
  // ИИ №28: было 0.18 — тот же запрос на более плавную/медленную
  // анимацию, теперь башня юнита-техники доворачивается неторопливее.
  vis.turretAngle += normalizeAngleDiff(turretAngle - vis.turretAngle) * 0.09;

  ctx.save();
  ctx.rotate(vis.turretAngle);
  ctx.fillStyle = darken(baseColor, 8);
  ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();

  if (isHeavy) {
    // ИИ №22: спаренный ствол вместо одного — главный визуальный маркер
    // heavyTank, узнаваем даже без сравнения размеров с обычным tank.
    ctx.fillStyle = "#232320";
    ctx.fillRect(0, -4.2, r * 1.05, 3.2);
    ctx.fillRect(0, 1.0, r * 1.05, 3.2);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.strokeRect(0, -4.2, r * 1.05, 3.2);
    ctx.strokeRect(0, 1.0, r * 1.05, 3.2);
  } else {
    ctx.fillStyle = "#2a2a26";
    ctx.fillRect(0, -2.6, r * 0.95, 5.2);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.strokeRect(0, -2.6, r * 0.95, 5.2);
  }

  if (u.attackCooldownLeft > (udef.attackCooldown || 1) - 100) {
    ctx.fillStyle = "rgba(255,210,120,0.95)";
    const flashX = isHeavy ? r * 1.05 : r * 0.95;
    ctx.beginPath(); ctx.arc(flashX, isHeavy ? -2.6 : 0, isHeavy ? 3 : 4, 0, Math.PI * 2); ctx.fill();
    if (isHeavy) { ctx.beginPath(); ctx.arc(flashX, 2.6, 3, 0, Math.PI * 2); ctx.fill(); }
    const shellTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    if (shellTarget) {
      const muzzleWorld = { x: u.x + Math.cos(vis.turretAngle) * flashX, y: u.y + Math.sin(vis.turretAngle) * flashX };
      maybeSpawnShotProjectile(vis, muzzleWorld.x, muzzleWorld.y, shellTarget.x, shellTarget.y, "shell", u.attackCooldownLeft);
    }
  }
  ctx.restore();
}

// БТР (apc): лёгкая колёсная техника — раньше молча рисовалась через
// drawInfantry (фолбэк-ветка), т.е. на экране выглядела как пехотинец с
// пистолетом, хотя это машина с bodyRadius=18. Ключевые отличия силуэта от
// drawTank: КОЛЁСА (кружки со спицами) вместо сплошных гусеничных лент,
// более узкий и вытянутый корпус со скошенным "носом" (лобовая броня БРТ
// классически покатая), курсовой пулемёт ЖЁСТКО закреплён по корпусу и
// поворачивается ВМЕСТЕ с ним — специально БЕЗ отдельной вращающейся башни,
// как у tank/heavyTank, чтобы читалось "дешёвая ранняя машина", а не
// "маленький танк". Колёса визуально прокручиваются при движении (fake-spin
// по фазе от времени, не завязано на реальную скорость — дёшево и достаточно
// для прототипа).
function drawApc(u, udef, baseColor, vis, t) {
  const r = udef.bodyRadius || 18;
  const bodyW = r * 1.55, bodyH = r * 0.8;

  // след колёс — та же логика throttle, что и у tank (см. drawTank), но
  // тоньше и реже — колёсная техника оставляет менее выраженный отпечаток.
  if ((u.state === "moving" || u.state === "returning" || u.state === "moving-to-harvest") && (!vis.lastTrackT || t - vis.lastTrackT > 160)) {
    vis.lastTrackT = t;
    FX.tracks.push({ x: u.x, y: u.y, angle: vis.angle, t0: t, w: bodyW * 0.55 });
  }

  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(0, bodyH * 0.6, bodyW * 0.6, bodyH * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.rotate(vis.angle);

  // ИИ (фикс по фидбеку "БТР похож на дрон"): раньше колёса были 4 круглых
  // диска, ТОРЧАЩИХ за боковой габарит корпуса, каждый со спицами-лучами —
  // вид сверху на четыре торчащих кружка с лучами читается как роторы
  // квадрокоптера, не как колёсная техника. Реальный БТР сверху показывает
  // колёса как невысокие ВЫСТУПЫ-АРКИ вдоль бортов (колёсные ниши), не
  // отдельные диски: рисуем каждую пару колёс одним вытянутым тёмным
  // прямоугольником-бруском почти вровень с корпусом (выступает на 1-2px,
  // не половиной диаметра наружу), со скруглёнными торцами и тонкими
  // поперечными рисками протектора вместо круглых спиц.
  const wheelH = bodyH * 0.16;
  const wheelInset = 1.5; // насколько выступ выходит за боковую грань корпуса
  const wheelPairs = [
    [-bodyW * 0.30, bodyW * 0.06], // передняя пара (по оси X: от..до)
    [bodyW * 0.14, bodyW * 0.42],  // задняя пара
  ];
  [-1, 1].forEach(side => {
    const wy = side * (bodyH / 2 + wheelInset - wheelH * 0.5);
    wheelPairs.forEach(([xa, xb]) => {
      ctx.fillStyle = "#131311";
      roundRect(xa, wy - wheelH / 2, xb - xa, wheelH, wheelH * 0.4);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 0.6;
      roundRect(xa, wy - wheelH / 2, xb - xa, wheelH, wheelH * 0.4); ctx.stroke();
      // риски протектора — тонкие поперечные штрихи, читаются как рифление
      // резины, не крутятся (колёса скрыты корпусом, вращение не видно
      // сверху у настоящего БТР — в отличие от прошлой версии со спицами)
      ctx.strokeStyle = "rgba(90,88,82,0.4)"; ctx.lineWidth = 0.6;
      const notches = Math.max(2, Math.round((xb - xa) / 3));
      for (let i = 1; i < notches; i++) {
        const nx = xa + (xb - xa) * (i / notches);
        ctx.beginPath(); ctx.moveTo(nx, wy - wheelH * 0.4); ctx.lineTo(nx, wy + wheelH * 0.4); ctx.stroke();
      }
    });
  });

  // корпус — скошенный нос (клинообразный многоугольник, не прямоугольник
  // как у tank), придаёт "покатую лобовую броню" классического БТР.
  const grad = cachedLinearGradient(0, -bodyH / 2, 0, bodyH / 2, lighten(baseColor, 16), darken(baseColor, 22), "apc|" + baseColor + "|" + bodyH);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(bodyW / 2, 0);
  ctx.lineTo(bodyW * 0.32, -bodyH / 2);
  ctx.lineTo(-bodyW / 2, -bodyH / 2);
  ctx.lineTo(-bodyW / 2, bodyH / 2);
  ctx.lineTo(bodyW * 0.32, bodyH / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1.2; ctx.stroke();

  // фары спереди по бокам носа — маленькие тёплые точки, добавляют технике
  // "лицо" и продают силуэт как машину, а не абстрактную форму
  ctx.fillStyle = "rgba(255,225,170,0.85)";
  ctx.beginPath(); ctx.arc(bodyW * 0.44, -bodyH * 0.32, 1.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(bodyW * 0.44, bodyH * 0.32, 1.1, 0, Math.PI * 2); ctx.fill();

  // антенна на корме — гибкий хлыст, слегка покачивается от движения,
  // ещё один силуэтный маркер "это наземная машина со связью", не дрон
  ctx.strokeStyle = "rgba(20,20,18,0.8)"; ctx.lineWidth = 1;
  const antennaBend = Math.sin(t / 260) * 2;
  ctx.beginPath();
  ctx.moveTo(-bodyW * 0.46, -bodyH * 0.15);
  ctx.quadraticCurveTo(-bodyW * 0.46 - 6, -bodyH * 0.15 - 6 + antennaBend, -bodyW * 0.46 - 9, -bodyH * 0.15 - 12 + antennaBend);
  ctx.stroke();

  // люк десанта на крыше — маленький прямоугольник ближе к корме
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(-bodyW * 0.28, -bodyH * 0.28, bodyW * 0.22, bodyH * 0.56);

  // курсовой пулемёт — жёстко по корпусу (НЕ отдельная башня), короткий
  // ствол ближе к носу
  ctx.fillStyle = "#242420";
  ctx.fillRect(bodyW * 0.42, -1.6, r * 0.55, 3.2);
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.6;
  ctx.strokeRect(bodyW * 0.42, -1.6, r * 0.55, 3.2);

  if (u.attackCooldownLeft > (udef.attackCooldown || 1) - 80) {
    ctx.fillStyle = "rgba(255,220,140,0.9)";
    ctx.beginPath(); ctx.arc(bodyW * 0.42 + r * 0.55, 0, 2.6, 0, Math.PI * 2); ctx.fill();
    const apcTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    if (apcTarget) {
      const muzzleX = bodyW * 0.42 + r * 0.55;
      const muzzleWorld = { x: u.x + Math.cos(vis.angle) * muzzleX, y: u.y + Math.sin(vis.angle) * muzzleX };
      maybeSpawnShotProjectile(vis, muzzleWorld.x, muzzleWorld.y, apcTarget.x, apcTarget.y, "bullet", u.attackCooldownLeft);
    }
  }
  ctx.restore();
}

// Авиация: треугольный корпус с крыльями, вращающийся пропеллер/турбина,
// заметно приподнят тенью от земли, лёгкое покачивание в полёте.
function drawAircraft(u, udef, baseColor, vis, t) {
  const wobble = Math.sin(t / 260 + vis.bob) * 2;

  // тень на земле — отдельно от корпуса, не наследует поворот/покачивание
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(0, 14, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(0, -6 + wobble * 0.3);
  ctx.rotate(vis.angle + Math.PI / 2);

  // крылья
  ctx.fillStyle = darken(baseColor, 10);
  ctx.beginPath();
  ctx.moveTo(-3, 2); ctx.lineTo(-13, 8); ctx.lineTo(-3, 6); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(3, 2); ctx.lineTo(13, 8); ctx.lineTo(3, 6); ctx.closePath(); ctx.fill();

  // фюзеляж
  const grad = cachedLinearGradient(0, -10, 0, 8, lighten(baseColor, 20), darken(baseColor, 15), "aircraft|" + baseColor);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(6, 7);
  ctx.lineTo(0, 4);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // кабина
  ctx.fillStyle = "rgba(120,220,255,0.55)";
  ctx.beginPath(); ctx.ellipse(0, -3, 2, 3.4, 0, 0, Math.PI * 2); ctx.fill();

  // пропеллер/турбина сзади — быстро вращающийся диск (просто мигание спиц)
  const spin = (t / 40) % Math.PI;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(Math.sin(spin) * 5, 7 + Math.cos(spin) * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(-Math.sin(spin) * 5, 7 - Math.cos(spin) * 2); ctx.stroke();

  if (u.attackCooldownLeft > (udef.attackCooldown || 1) - 90) {
    ctx.fillStyle = "rgba(255,220,140,0.9)";
    ctx.beginPath(); ctx.arc(0, -11, 3, 0, Math.PI * 2); ctx.fill();
    const airTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    if (airTarget) {
      // штурмовик бьёт по цели с высоты — упрощаем старт снаряда до позиции
      // самого юнита (визуальная разница в несколько px на глаз незаметна)
      maybeSpawnShotProjectile(vis, u.x, u.y, airTarget.x, airTarget.y, "rocket", u.attackCooldownLeft);
    }
  }
  ctx.restore();
}

// ИИ №34: вертолёт "Коршун" (gunship) — второй летающий юнит, силуэт
// намеренно НЕ похож на drawAircraft (тот — треугольный реактивный
// фюзеляж со стреловидными крыльями): здесь вытянутый горизонтальный
// корпус вертолёта, ХОРОШО ВИДНЫЙ несущий винт сверху (быстро вращающийся
// размытый диск — главный узнаваемый признак вертолёта в отличие от
// самолёта) и маленький хвостовой винт сбоку на длинной хвостовой балке.
// Летает НИЖЕ и медленнее, чем aircraft — тень крупнее и темнее (ближе к
// земле), покачивание мягче (тяжёлая машина, не юркий истребитель).
function drawGunship(u, udef, baseColor, vis, t) {
  const wobble = Math.sin(t / 340 + vis.bob) * 1.3; // медленнее и мягче, чем у aircraft (t/260)

  // тень на земле — крупнее и темнее тени aircraft (летает ниже, тяжелее)
  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(0, 12, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(0, -5 + wobble * 0.3);
  ctx.rotate(vis.angle);

  // хвостовая балка — тонкая, уходит назад от корпуса, с маленьким
  // рулевым винтом на конце (вертикальный, в отличие от несущего)
  ctx.fillStyle = darken(baseColor, 12);
  ctx.fillRect(-15, -1.3, 9, 2.6);
  const tailSpin = (t / 30) % Math.PI;
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-15, 0); ctx.lineTo(-15, -4 + Math.sin(tailSpin) * 3.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-15, 0); ctx.lineTo(-15, 4 - Math.sin(tailSpin) * 3.5); ctx.stroke();

  // корпус — вытянутая приземистая капсула (не треугольный фюзеляж, как
  // у aircraft), кабина спереди шире, к хвосту сужается
  const gunshipGradKey = "gunship|" + baseColor;
  let grad = _gradientCache.get(gunshipGradKey);
  if (!grad) {
    grad = ctx.createLinearGradient(-9, 0, 9, 0);
    grad.addColorStop(0, darken(baseColor, 12));
    grad.addColorStop(0.5, lighten(baseColor, 16));
    grad.addColorStop(1, darken(baseColor, 8));
    _gradientCache.set(gunshipGradKey, grad);
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(11, 0);
  ctx.quadraticCurveTo(9, -5.5, -2, -5);
  ctx.lineTo(-8, -3);
  ctx.lineTo(-8, 3);
  ctx.lineTo(-2, 5);
  ctx.quadraticCurveTo(9, 5.5, 11, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1; ctx.stroke();

  // кабина остеклённая — крупнее, чем у aircraft (обзор вниз для
  // штурмовки, не скоростная капля истребителя)
  ctx.fillStyle = "rgba(140,215,235,0.5)";
  ctx.beginPath(); ctx.ellipse(6, 0, 3.6, 3.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 0.6; ctx.stroke();

  // полозья шасси — короткие тёмные штрихи снизу, ещё один силуэтный
  // маркер "вертолёт", у aircraft их нет вовсе
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(-4, 5.5); ctx.lineTo(6, 5.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-2, 4); ctx.lineTo(-2, 6.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(4, 4); ctx.lineTo(4, 6.2); ctx.stroke();

  // пилон с блоком НУРС по борту — короткая труба-решётка снизу корпуса,
  // явный намёк на противотанковое вооружение, ещё до выстрела
  ctx.fillStyle = "#232420";
  ctx.fillRect(-1, 6, 7, 2.6);
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.5; ctx.strokeRect(-1, 6, 7, 2.6);

  // несущий винт — размытый вращающийся диск НАД корпусом (не спицы, как
  // хвостовой) — при полной скорости читается как полупрозрачный круг,
  // главный признак "это вертолёт", видимый даже издалека
  const rotorSpin = (t / 22) % (Math.PI * 2);
  ctx.save();
  ctx.translate(0, -7);
  ctx.rotate(rotorSpin);
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = "rgba(230,230,225,0.8)";
  ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(-16, 0); ctx.lineTo(16, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(0, 16); ctx.stroke();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "rgba(220,220,215,1)";
  ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // втулка винта — маленькая тёмная точка по центру, статична (не крутится)
  ctx.fillStyle = "#1a1a17";
  ctx.beginPath(); ctx.arc(0, -7, 1.6, 0, Math.PI * 2); ctx.fill();

  if (u.attackCooldownLeft > (udef.attackCooldown || 1) - 130) {
    // залп ПТУР — крупнее и медленнее гаснущая вспышка, чем у aircraft
    // (соответствует редкому тяжёлому выстрелу вместо частой очереди)
    ctx.fillStyle = "rgba(255,200,110,0.95)";
    ctx.beginPath(); ctx.arc(6, 8.3, 3.5, 0, Math.PI * 2); ctx.fill();
    const gunshipTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    if (gunshipTarget) {
      maybeSpawnShotProjectile(vis, u.x, u.y, gunshipTarget.x, gunshipTarget.y, "rocket", u.attackCooldownLeft);
    }
  }
  ctx.restore();
}

// ИИ №34: самоходка "Гроза" (artillery) — дальнобойная САУ на колёсном
// шасси. Отличия от drawTank/drawApc: ОЧЕНЬ длинный тонкий ствол-хобот
// (заметно длиннее пушки heavyTank), направленный НАЗАД относительно
// корпуса при движении и разворачивающийся к цели только при стрельбе
// (характерная поза САУ — марш задом наперёд относительно орудия), узкая
// открытая рама лафета вместо закрытого бронекорпуса tank/heavyTank —
// читается как "хрупкая пушка на колёсах", не танк.
function drawArtillery(u, udef, baseColor, vis, t) {
  const r = udef.bodyRadius || 21;
  const bodyW = r * 1.3, bodyH = r * 0.85;

  if ((u.state === "moving" || u.state === "returning") && (!vis.lastTrackT || t - vis.lastTrackT > 170)) {
    vis.lastTrackT = t;
    FX.tracks.push({ x: u.x, y: u.y, angle: vis.angle, t0: t, w: bodyW * 0.5 });
  }

  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.ellipse(0, bodyH * 0.5, bodyW * 0.65, bodyH * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.rotate(vis.angle);

  // открытая рама-лафет — уже и площе корпуса tank, тёмная сталь без
  // "брони" (просто силовой каркас, на который поставлено орудие)
  ctx.fillStyle = "#242320";
  ctx.fillRect(-bodyW * 0.35, -bodyH * 0.42, bodyW * 0.7, bodyH * 0.84);
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1; ctx.strokeRect(-bodyW * 0.35, -bodyH * 0.42, bodyW * 0.7, bodyH * 0.84);

  // кабина/рубка водителя спереди — маленькая, приземистая
  const grad = cachedLinearGradient(0, -bodyH / 2, 0, bodyH / 2, lighten(baseColor, 14), darken(baseColor, 22), "artillery|" + baseColor + "|" + bodyH);
  ctx.fillStyle = grad;
  roundRectLocal(bodyW * 0.12, -bodyH * 0.38, bodyW * 0.36, bodyH * 0.76, 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1; roundRectLocal(bodyW * 0.12, -bodyH * 0.38, bodyW * 0.36, bodyH * 0.76, 2); ctx.stroke();

  // колёса — те же невысокие выступы-арки, что у apc (не спицы), но
  // всего одна пара крупных колёс на борт (тяжёлое медленное шасси)
  const wheelH = bodyH * 0.2;
  [-1, 1].forEach(side => {
    const wy = side * (bodyH / 2 + 1 - wheelH * 0.5);
    ctx.fillStyle = "#131311";
    roundRect(-bodyW * 0.3, wy - wheelH / 2, bodyW * 0.55, wheelH, wheelH * 0.4);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 0.6;
    roundRect(-bodyW * 0.3, wy - wheelH / 2, bodyW * 0.55, wheelH, wheelH * 0.4); ctx.stroke();
  });

  // орудие — целится независимо от корпуса, как башня tank, но САМ
  // ствол значительно длиннее любого другого орудия в игре и опирается
  // на видимый шарнир-станину сзади рамы (не спереди, как у tank) —
  // силуэт "пушка растёт из кормы", узнаваем даже на статичном кадре.
  let gunAngle = vis.angle;
  const target = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
  if (target && dist(u.x, u.y, target.x, target.y) > 4) gunAngle = Math.atan2(target.y - u.y, target.x - u.x);
  if (vis.turretAngle == null) vis.turretAngle = gunAngle;
  vis.turretAngle += normalizeAngleDiff(gunAngle - vis.turretAngle) * 0.07; // медленнее tank (0.09) — тяжёлый громоздкий лафет

  ctx.save();
  ctx.rotate(vis.turretAngle);
  // станина-шарнир
  ctx.fillStyle = "#1c1b18";
  ctx.beginPath(); ctx.arc(-bodyW * 0.1, 0, r * 0.32, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();
  // длинный тонкий ствол
  const gunLen = r * 1.55;
  ctx.fillStyle = "#2a2a25";
  ctx.fillRect(-bodyW * 0.1, -1.7, gunLen, 3.4);
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.6; ctx.strokeRect(-bodyW * 0.1, -1.7, gunLen, 3.4);
  // дульный тормоз на конце — характерная утолщённая муфта
  ctx.fillStyle = "#1c1b18";
  ctx.fillRect(-bodyW * 0.1 + gunLen - 3, -2.6, 4, 5.2);

  if (u.attackCooldownLeft > (udef.attackCooldown || 1) - 140) {
    // самый долгий и заметный выстрел в игре — крупная яркая вспышка на
    // дульном тормозе (соответствует самому долгому attackCooldown)
    ctx.fillStyle = "rgba(255,225,150,0.95)";
    const muzzleX = -bodyW * 0.1 + gunLen;
    ctx.beginPath(); ctx.arc(muzzleX, 0, 4.5, 0, Math.PI * 2); ctx.fill();
    const artilleryTarget = u.attackTargetId ? findAttackableAt(u.attackTargetId) : null;
    if (artilleryTarget) {
      const muzzleWorld = { x: u.x + Math.cos(vis.turretAngle) * muzzleX, y: u.y + Math.sin(vis.turretAngle) * muzzleX };
      maybeSpawnShotProjectile(vis, muzzleWorld.x, muzzleWorld.y, artilleryTarget.x, artilleryTarget.y, "shell", u.attackCooldownLeft);
    }
  }
  ctx.restore();
  ctx.restore();
}

/* ================================================================
   ВЫДЕЛЕНИЕ / ТРАССЫ АТАКИ / HP-БАР
   ================================================================ */

// "Marching ants" — вращающийся пунктир вокруг здания, читается как военный
// таргетинг-маркер, а не просто статичная рамка.
function drawSelectionRectAnimated(x, y, w, h, t) {
  ctx.save();
  ctx.strokeStyle = "#c9a227";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -(t / 30) % 10;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();

  // короткие уголки поверх пунктира — фиксируют "рамку прицела" на месте
  ctx.save();
  ctx.strokeStyle = "#e6bc3a";
  ctx.lineWidth = 2;
  const cl = Math.min(14, w * 0.25, h * 0.25);
  [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + cl * sy); ctx.lineTo(cx, cy); ctx.lineTo(cx + cl * sx, cy);
    ctx.stroke();
  });
  ctx.restore();
}

function drawSelectionRingAnimated(cx, cy, r, t) {
  const pulse = 1 + Math.sin(t / 260) * 0.06;
  ctx.save();
  ctx.strokeStyle = "#c9a227";
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([3, 5]);
  ctx.lineDashOffset = -(t / 25) % 8;
  ctx.strokeStyle = "rgba(230,188,58,0.55)";
  ctx.beginPath(); ctx.arc(cx, cy, r * pulse + 3, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawAttackTracer(sx, sy, target, t) {
  const ts = worldToScreen(target.x, target.y);
  ctx.save();
  ctx.strokeStyle = "rgba(193,56,42,0.55)";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([3, 4]);
  ctx.lineDashOffset = -(t / 20) % 7;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ts.x, ts.y); ctx.stroke();
  ctx.restore();
}

// ИИ (визуал): добавлены тонкие деления (сегменты по 20% как в классических
// RTS-барах) и мягкое пульсирующее свечение при критическом HP (<20%) —
// раньше плоская заливка без делений слабо читалась на мелких юнитах и
// не давала дополнительного сигнала "тревога" при низком здоровье помимо
// смены цвета.
function drawHpBar(x, y, w, hp, maxHp) {
  const pct = Math.max(0, hp / maxHp);
  const critical = pct > 0 && pct <= 0.2;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(x - 1, y - 1, w + 2, 5, 2); ctx.fill();
  ctx.fillStyle = "#2a1010";
  roundRect(x, y, w, 3, 1.5); ctx.fill();
  const color = pct > 0.5 ? "#2f6f4f" : (pct > 0.2 ? "#c9a227" : "#c1382a");
  if (critical) {
    ctx.shadowColor = "rgba(193,56,42,0.9)";
    ctx.shadowBlur = 3 + Math.sin(nowT() / 180) * 2;
  }
  ctx.fillStyle = color;
  if (pct > 0) { roundRect(x, y, Math.max(2, w * pct), 3, 1.5); ctx.fill(); }
  ctx.shadowBlur = 0;
  // деления каждые 20% — тонкие тёмные насечки поверх заливки
  if (w > 12) {
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 0.6;
    for (let i = 1; i < 5; i++) {
      const dx = x + (w / 5) * i;
      ctx.beginPath(); ctx.moveTo(dx, y); ctx.lineTo(dx, y + 3); ctx.stroke();
    }
  }
  ctx.restore();
}

/* ================================================================
   ФОГ ВОЙНЫ / ПРИЗРАКИ / ЭФФЕКТЫ СМЕРТИ
   (логика видимости не менялась — только чуть более "живая" отрисовка)
   ================================================================ */
function drawFogBuildingMemory(t) {
  if (!GameConfig.fogEnabled) return;
  Object.values(State.fog.buildingGhosts).forEach(ghost => {
    if (isWorldPointVisible(ghost.x, ghost.y)) return;
    const def = BuildingDefs[ghost.type];
    if (!def) return;
    const s = worldToScreen(ghost.x, ghost.y);
    const w = def.w * GameConfig.tileSize, h = def.h * GameConfig.tileSize;
    if (s.x < -w || s.y < -h || s.x > visibleWorldWidth() + w || s.y > visibleWorldHeight() + h) return;
    ctx.save();
    ctx.globalAlpha = 0.3 + Math.sin(t / 1200) * 0.03;
    ctx.fillStyle = "#5a4a3a";
    roundRect(s.x - w / 2, s.y - h / 2, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.setLineDash([4, 3]);
    roundRect(s.x - w / 2, s.y - h / 2, w, h, 3);
    ctx.stroke();
    ctx.restore();
  });
}

function drawFogOverlay() {
  if (!GameConfig.fogEnabled) return;
  const fts = GameConfig.fogTileSize;
  const startCol = Math.floor(State.camera.x / fts) - 1;
  const startRow = Math.floor(State.camera.y / fts) - 1;
  const colsOnScreen = Math.ceil(visibleWorldWidth() / fts) + 2;
  const rowsOnScreen = Math.ceil(visibleWorldHeight() / fts) + 2;

  for (let dc = 0; dc < colsOnScreen; dc++) {
    for (let dr = 0; dr < rowsOnScreen; dr++) {
      const col = startCol + dc, row = startRow + dr;
      const key = fogKey(col, row);
      const isVisible = State.fog.visible.has(key);
      if (isVisible) continue;
      const isExplored = State.fog.explored.has(key);
      const worldX = col * fts, worldY = row * fts;
      const s = worldToScreen(worldX, worldY);
      ctx.fillStyle = isExplored ? "rgba(6,8,5,0.55)" : "rgba(4,5,3,0.94)";
      ctx.fillRect(s.x, s.y, fts + 1, fts + 1);
    }
  }
}

function drawBuildGhost() {
  if (!State.buildMode) return;
  const def = BuildingDefs[State.buildMode.type];
  if (!def) return;
  const s = worldToScreen(State.buildGhostWorld.x, State.buildGhostWorld.y);
  const w = def.w * GameConfig.tileSize, h = def.h * GameConfig.tileSize;
  const ok = State.buildMode.valid;
  const t = nowT();
  const pulse = 0.85 + Math.sin(t / 260) * 0.1;

  ctx.save();
  ctx.globalAlpha = 0.45 * pulse;
  ctx.fillStyle = ok ? "#2f6f4f" : "#8a2a1f";
  ctx.fillRect(s.x - w / 2, s.y - h / 2, w, h);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = ok ? "#6fd39f" : "#e0645a";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.lineDashOffset = -(t / 30) % 7;
  ctx.strokeRect(s.x - w / 2, s.y - h / 2, w, h);
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.restore();
}

function renderRemoteGhosts() {
  if (!State.remoteGhosts) return;
  Object.values(State.remoteGhosts).forEach(pdata => {
    if (!pdata) return;
    ctx.save();
    ctx.globalAlpha = 0.55;

    Object.values(pdata.buildings || {}).forEach(b => {
      const s = worldToScreen(b.x, b.y);
      if (s.x < -40 || s.y < -40 || s.x > visibleWorldWidth() + 40 || s.y > visibleWorldHeight() + 40) return;
      const def = BuildingDefs[b.type];
      if (!def) return;
      const w = def.w * GameConfig.tileSize, h = def.h * GameConfig.tileSize;
      ctx.fillStyle = "#5a6a8a";
      roundRect(s.x - w / 2, s.y - h / 2, w, h, 3);
      ctx.fill();
      ctx.strokeStyle = "#000";
      roundRect(s.x - w / 2, s.y - h / 2, w, h, 3);
      ctx.stroke();
    });

    Object.values(pdata.units || {}).forEach(u => {
      const s = worldToScreen(u.x, u.y);
      if (s.x < -20 || s.y < -20 || s.x > visibleWorldWidth() + 20 || s.y > visibleWorldHeight() + 20) return;
      ctx.fillStyle = "#5a6a8a";
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.stroke();
    });

    ctx.restore();
  });
}

// Искры при попадании — короткие разлетающиеся веером линии-осколки в
// направлении, обратном атаке (см. updateHitFlash: angle = откуда прилетело
// + PI). Раньше FX.hitSparks только накапливался и никогда не рисовался —
// чистая утечка без визуального эффекта; теперь это основной "чувствуется
// удар" сигнал отдельно от белой вспышки объекта.
function drawHitSparks(t) {
  for (let i = FX.hitSparks.length - 1; i >= 0; i--) {
    const sp = FX.hitSparks[i];
    const age = t - sp.t0;
    const dur = 220;
    if (age > dur) { FX.hitSparks.splice(i, 1); continue; }
    const s = worldToScreen(sp.x, sp.y);
    // ОПТИМИЗАЦИЯ (перф): viewport culling — искры вне экрана раньше всё
    // равно проходили полную отрисовку (save/rotate x5 на каждую).
    if (s.x < -20 || s.y < -20 || s.x > visibleWorldWidth() + 20 || s.y > visibleWorldHeight() + 20) continue;
    const p = age / dur;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(sp.angle);
    const n = 4;
    for (let k = 0; k < n; k++) {
      const spread = (k - n / 2) * 0.35 + (Math.sin(k * 7.13) * 0.15);
      const len = (5 + k * 1.5) * (1 - p);
      const dist0 = p * 9;
      ctx.save();
      ctx.rotate(spread);
      ctx.strokeStyle = `rgba(255,230,170,${(1 - p) * 0.9})`;
      ctx.lineWidth = 1.4 * (1 - p * 0.6);
      ctx.beginPath();
      ctx.moveTo(dist0, 0);
      ctx.lineTo(dist0 + len, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
}

// Летящие снаряды — регистрируются из drawUnit/drawTank/drawTurretDetail в
// момент дульной вспышки (см. spawnProjectile, вызовы рядом с "дульная
// вспышка" в каждой draw*-функции ниже). kind определяет визуал:
//  - 'bullet' (rifleman/sniper/apc/turret) — тонкая быстрая трассирующая линия
//  - 'shell' (tank/heavyTank) — короткий яркий сгусток с дымным следом
//  - 'rocket' (rocketeer/grenadier/aircraft) — снаряд с хвостом пламени,
//    летит заметно медленнее пули/снаряда (визуально "тяжелее")
// Долетев (age>=dur), снаряд регистрирует impact в точке назначения — сам
// урон уже применён боевой системой раньше, это чисто отложенный по времени
// визуал "снаряд ещё в пути", отдельный от факта попадания в hp.
function spawnProjectile(x0, y0, x1, y1, kind) {
  const d = dist(x0, y0, x1, y1);
  const speed = kind === "shell" ? 1.1 : (kind === "rocket" ? 0.55 : 2.2); // px/ms
  const dur = clamp(d / speed, 40, 420);
  FX.projectiles.push({ x0, y0, x1, y1, t0: nowT(), dur, kind });
}

// Хелпер для мест "дульная вспышка сразу после выстрела": та же проверка
// attackCooldownLeft > max-window уже используется, чтобы РИСОВАТЬ вспышку
// каждый кадр внутри окна — но снаряд должен СПАВНИТЬСЯ только один раз за
// выстрел, не на каждом кадре, пока окно открыто (иначе за ~80-100мс окна
// при 60fps вылетит 5-6 снарядов на один реальный выстрел). vis.lastShotAt
// хранит attackCooldownLeft, при котором снаряд уже был создан для текущего
// цикла перезарядки — сравниваем не по времени, а по тому, что
// attackCooldownLeft УМЕНЬШИЛСЯ с прошлой проверки (значит это тот же
// выстрел, а не новый) — как только увидели рост (новый цикл), спавним
// заново и запоминаем.
function maybeSpawnShotProjectile(vis, x0, y0, x1, y1, kind, cooldownLeft) {
  if (vis.lastShotCooldown == null || cooldownLeft > vis.lastShotCooldown + 1) {
    spawnProjectile(x0, y0, x1, y1, kind);
  }
  vis.lastShotCooldown = cooldownLeft;
}

function drawProjectiles(t) {
  for (let i = FX.projectiles.length - 1; i >= 0; i--) {
    const pr = FX.projectiles[i];
    const age = t - pr.t0;
    if (age >= pr.dur) {
      FX.impacts.push({ x: pr.x1, y: pr.y1, t0: t, kind: pr.kind === "bullet" ? "small" : "big" });
      if (pr.kind !== "bullet") triggerShake(pr.kind === "shell" ? 2.5 : 3.5, 140);
      FX.projectiles.splice(i, 1);
      continue;
    }
    const p = age / pr.dur;
    const cx = pr.x0 + (pr.x1 - pr.x0) * p, cy = pr.y0 + (pr.y1 - pr.y0) * p;
    const s = worldToScreen(cx, cy);
    // ОПТИМИЗАЦИЯ (перф): viewport culling — снаряды за пределами видимой
    // области раньше всё равно проходили полную отрисовку (save/rotate/
    // gradient/stroke). В крупных боях с десятками одновременных выстрелов
    // за кадром большая часть карты (и её снаряды) обычно вне экрана.
    if (s.x < -30 || s.y < -30 || s.x > visibleWorldWidth() + 30 || s.y > visibleWorldHeight() + 30) continue;
    const s0 = worldToScreen(pr.x0, pr.y0);
    const ang = Math.atan2(pr.y1 - pr.y0, pr.x1 - pr.x0);

    if (pr.kind === "bullet") {
      // тонкая трассирующая полоса позади текущей точки, гаснущая к хвосту
      const tailLen = Math.min(14, dist(s0.x, s0.y, s.x, s.y));
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(ang);
      // тот же градиент переиспользуется для всех пуль — геометрия и цвета
      // трассера константны (0..-tailLen, tailLen почти всегда == 14, кап
      // из Math.min выше), кэш по округлённой длине хвоста избегает
      // пересоздания CanvasGradient на каждую пулю каждый кадр.
      const grad = cachedLinearGradient(-Math.round(tailLen), 0, 0, 0, "rgba(255,235,180,0)", "rgba(255,245,200,0.95)", "bullet|" + Math.round(tailLen));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-tailLen, 0); ctx.lineTo(0, 0); ctx.stroke();
      ctx.restore();
    } else if (pr.kind === "shell") {
      // компактный яркий снаряд с коротким дымным хвостом
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(ang);
      ctx.fillStyle = "rgba(60,55,50,0.45)";
      ctx.beginPath(); ctx.ellipse(-7, 0, 6, 1.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff6d8";
      ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (pr.kind === "rocket") {
      // снаряд с хвостом пламени/дыма — медленнее, крупнее, заметнее в полёте
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(ang);
      for (let k = 0; k < 5; k++) {
        const fk = k / 5;
        ctx.fillStyle = `rgba(${200 - k * 20},${90 - k * 15},40,${0.5 * (1 - fk)})`;
        ctx.beginPath(); ctx.arc(-6 - k * 3, (Math.random() - 0.5) * 1.5, 2.6 - fk * 1.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#2a2a26";
      ctx.beginPath(); ctx.ellipse(0, 0, 3.4, 1.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,220,150,0.9)";
      ctx.beginPath(); ctx.arc(-3, 0, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}

// Вспышки попадания — маленькая яркая вспышка + расширяющееся затухающее
// кольцо ударной волны. 'big' (снаряды техники/ракеты) заметно крупнее и
// добавляет короткий дымный пшик, 'small' (пули) — почти мгновенная искра.
function drawImpacts(t) {
  for (let i = FX.impacts.length - 1; i >= 0; i--) {
    const im = FX.impacts[i];
    const age = t - im.t0;
    const big = im.kind === "big";
    const dur = big ? 320 : 140;
    if (age > dur) { FX.impacts.splice(i, 1); continue; }
    const s = worldToScreen(im.x, im.y);
    // ОПТИМИЗАЦИЯ (перф): viewport culling — взрывы вне экрана раньше всё
    // равно создавали radial gradient и рисовались (в крупных боях с
    // десятками одновременных попаданий за пределами вида это заметно).
    if (s.x < -30 || s.y < -30 || s.x > visibleWorldWidth() + 30 || s.y > visibleWorldHeight() + 30) continue;
    const p = age / dur;
    const maxR = big ? 20 : 8;

    ctx.save();
    // вспышка ядра — ярче в начале, гаснет быстро
    const flashP = clamp(p * 3, 0, 1);
    ctx.globalAlpha = 1 - flashP;
    const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, maxR * 0.6);
    glow.addColorStop(0, "rgba(255,245,210,0.95)");
    glow.addColorStop(1, "rgba(255,180,80,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(s.x, s.y, maxR * 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // расширяющееся кольцо ударной волны
    ctx.save();
    ctx.globalAlpha = (1 - p) * 0.7;
    ctx.strokeStyle = big ? "rgba(255,200,120,0.8)" : "rgba(255,230,180,0.7)";
    ctx.lineWidth = big ? 2 : 1.2;
    ctx.beginPath(); ctx.arc(s.x, s.y, maxR * p, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    if (big) {
      // короткий дымный пшик над точкой попадания
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.35;
      ctx.fillStyle = "rgba(80,75,68,1)";
      ctx.beginPath(); ctx.arc(s.x, s.y - p * 10, 4 + p * 8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}

// Эффекты смерти — регистрируются из killUnit/killBuilding через хук ниже
// (см. конец файла), проигрывают короткую вспышку осколков и затухают
// сами по таймеру; не хранятся в State, т.к. чисто визуальны и не должны
// сериализоваться/синхронизироваться по сети.
// ИИ (визуал): d.kind теперь может быть 'unit'/'building'/'vehicle' (см. хук
// killUnit ниже — определяется по UnitDefs[type].bodyRadius). Техника
// (tank/heavyTank/apc/aircraft) горит дольше и гуще дымит вместо простого
// рассыпания на осколки — крупный металлический объект читается иначе,
// чем убитый пехотинец, который просто исчезает искрами.
function drawDeathEffects(t) {
  for (let i = FX.deaths.length - 1; i >= 0; i--) {
    const d = FX.deaths[i];
    const age = t - d.t0;
    const isVehicle = d.kind === "vehicle";
    const dur = d.kind === "building" ? 520 : (isVehicle ? 620 : 340);
    if (age > dur) { FX.deaths.splice(i, 1); continue; }
    const s = worldToScreen(d.x, d.y);
    // ОПТИМИЗАЦИЯ (перф): viewport culling — эффекты смерти вне экрана.
    if (s.x < -30 || s.y < -30 || s.x > visibleWorldWidth() + 30 || s.y > visibleWorldHeight() + 30) continue;
    const p = age / dur;
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.fillStyle = d.color;
    const n = d.kind === "building" ? 10 : (isVehicle ? 8 : 6);
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2 + k;
      const shardDist = p * (d.kind === "building" ? 26 : (isVehicle ? 22 : 16));
      ctx.beginPath();
      ctx.arc(s.x + Math.cos(ang) * shardDist, s.y + Math.sin(ang) * shardDist, Math.max(0.5, 3 - p * 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (isVehicle) {
      // отдельный дымовой столб поверх осколков — несколько поднимающихся
      // и расширяющихся серых клубов, гаснущих к концу анимации
      ctx.save();
      for (let k = 0; k < 4; k++) {
        const puffP = clamp(p * 1.3 - k * 0.12, 0, 1);
        if (puffP <= 0 || puffP >= 1) continue;
        const py = s.y - puffP * 22 - k * 2;
        const alpha = (1 - puffP) * 0.4;
        ctx.fillStyle = `rgba(60,55,50,${alpha})`;
        ctx.beginPath(); ctx.arc(s.x + Math.sin(k * 2 + puffP * 4) * 4, py, 3 + puffP * 7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }
}

/* ================================================================
   МЕЛКИЕ ГРАФИЧЕСКИЕ УТИЛИТЫ
   ================================================================ */
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// то же самое, но для уже транслированного (translate) контекста, где x/y
// координаты локальные (могут быть отрицательными) — используется внутри
// повёрнутых юнитов, чтобы не плодить путаницу со знаком в одной функции.
function roundRectLocal(x, y, w, h, r) { roundRect(x, y, w, h, r); }

function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function normalizeAngleDiff(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function hexToRgb(hex) {
  if (!hex || hex[0] !== "#") return { r: 200, g: 200, b: 200 };
  const n = hex.length === 4
    ? hex.slice(1).split("").map(c => parseInt(c + c, 16))
    : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return { r: n[0], g: n[1], b: n[2] };
}
// ОПТИМИЗАЦИЯ (перф): lighten/darken вызываются на КАЖДЫЙ юнит/здание
// КАЖДЫЙ кадр (например drawTank делает lighten(baseColor,15) +
// darken(baseColor,25) каждый вызов) — раньше это означало парсинг hex ->
// RGB и сборку новой строки "rgb(...)" по многу раз в секунду на объект,
// хотя baseColor (цвет игрока) практически никогда не меняется между
// кадрами. Результат теперь кэшируется по ключу "hex|amt" — тот же
// видимый эффект, ноль лишних аллокаций/парсинга на повторных вызовах с
// теми же аргументами. Кэш маленький (число цветов игроков * диапазон amt),
// не растёт бесконтрольно.
const _lightenCache = new Map();
function lighten(hex, amt) {
  const key = hex + "|" + amt;
  let v = _lightenCache.get(key);
  if (v === undefined) {
    const { r, g, b } = hexToRgb(hex);
    v = `rgb(${clamp(r + amt, 0, 255)},${clamp(g + amt, 0, 255)},${clamp(b + amt, 0, 255)})`;
    _lightenCache.set(key, v);
  }
  return v;
}
function darken(hex, amt) { return lighten(hex, -amt); }

/* ================================================================
   ХУК НА СМЕРТЬ ЮНИТОВ/ЗДАНИЙ ДЛЯ ЭФФЕКТОВ
   killUnit/killBuilding (07-game-loop-combat.js) удаляют объект из State
   ДО того, как рендер успеет увидеть hp<=0, поэтому вместо правки боевого
   файла оборачиваем обе функции здесь (после их определения в порядке
   загрузки скриптов, см. game.html: 07 подключается раньше 08) — рендер
   остаётся единственным местом, отвечающим "как это выглядит".
   ================================================================ */
(function hookDeathEffects() {
  const _killUnit = killUnit;
  killUnit = function (id) {
    const u = State.units[id];
    if (u) {
      const player = State.players[u.ownerId];
      // ИИ (визуал): техника (tank/heavyTank/apc/aircraft) отличается от
      // пехоты/рабочего дымным эффектом смерти (см. drawDeathEffects) —
      // определяем по udef.flying или bodyRadius>=16 (порог выше самого
      // крупного пехотинца rocketeer=14, ниже самой мелкой техники apc=18),
      // не заводим отдельное поле в UnitDefs ради одного визуального бита.
      const udef = UnitDefs[u.type];
      const isVehicle = udef && (udef.flying || (udef.bodyRadius || 0) >= 16);
      FX.deaths.push({ x: u.x, y: u.y, color: player ? player.color : "#fff", t0: nowT(), kind: isVehicle ? "vehicle" : "unit" });
      // взрыв техники — крупная impact-вспышка + заметная тряска камеры,
      // пехота гибнет тише (только осколки из drawDeathEffects, без shake)
      if (isVehicle) {
        FX.impacts.push({ x: u.x, y: u.y, t0: nowT(), kind: "big" });
        triggerShake(udef.bodyRadius >= 25 ? 7 : 4.5, 260);
      }
    }
    return _killUnit(id);
  };
  const _killBuilding = killBuilding;
  killBuilding = function (id) {
    const b = State.buildings[id];
    if (b) {
      const player = State.players[b.ownerId];
      FX.deaths.push({ x: b.x, y: b.y, color: player ? player.color : "#888", t0: nowT(), kind: "building" });
      // здание — самый крупный взрыв в игре: impact + сильная тряска
      FX.impacts.push({ x: b.x, y: b.y, t0: nowT(), kind: "big" });
      triggerShake(8, 340);
    }
    return _killBuilding(id);
  };
})();

// ОПТИМИЗАЦИЯ (перф, главная причина нагрева телефона): раньше render()
// вызывался БЕЗ ограничения на каждый requestAnimationFrame — на
// современных телефонах/мониторах это часто 90-120 кадров в секунду, хотя
// логика игры (gameTick) тикает всего 10 раз/сек и глазу больше 45-50
// кадров в секунду в RTS-камере ничего не даёт. Каждый лишний кадр — это
// полный проход по всем юнитам/зданиям/эффектам с десятками save/restore,
// заливок и градиентов (см. drawUnit/drawBuilding) — на мобильном GPU
// именно это удвоение-утроение частоты рендера почти без выигрыша в
// плавности и было основным источником нагрева/расхода батареи.
// RENDER_MIN_FRAME_MS ограничивает render() до ~45 fps (22мс) — игровая
// ЛОГИКА (gameTick, урон, экономика, ИИ) продолжает тикать с тем же
// GameConfig.tickRateMs, как и раньше, то есть на геймплей это не влияет
// вообще, меняется только то, как часто перерисовывается картинка.
const RENDER_MIN_FRAME_MS = 1000 / 45;

function loop(timestamp) {
  if (!loop.last) loop.last = timestamp;
  const dt = timestamp - loop.last;
  loop.last = timestamp;

  loop.acc = (loop.acc || 0) + dt;
  while (loop.acc >= GameConfig.tickRateMs) {
    gameTick(GameConfig.tickRateMs);
    loop.acc -= GameConfig.tickRateMs;
  }

  loop.renderAcc = (loop.renderAcc || 0) + dt;
  if (loop.renderAcc >= RENDER_MIN_FRAME_MS) {
    // не накапливаем "долг" по кадрам при коротких фризах (смена вкладки,
    // GC-пауза) — иначе после лага рендер попытался бы отрисовать
    // несколько кадров подряд, чтобы "нагнать" время
    loop.renderAcc = 0;
    render();
  }
  requestAnimationFrame(loop);
}