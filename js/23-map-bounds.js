/* ---------------------------- ИИ №40: границы карты (невидимые стены) ---------------------------- */
// Прямой запрос пользователя: "у карты нету чётких границ, нужны видимые
// стены которые юниты и камера не переступают". До этой правки
// GameConfig.mapTilesW/H (01-config-state.js) существовал ЧИСТО как число
// для генерации/патфайндинга и НИГДЕ не ограничивал ни камеру
// (09-input.js двигает State.camera.x/y напрямую в нескольких местах —
// драг тачем, WASD/стрелки, кнопка "центр", зум — без единой проверки
// границ), ни цель движения юнита (setUnitDestination, 03-pathfinding.js,
// единая точка входа для ЛЮБОГО приказа на мировую точку — здесь тоже не
// было клампа). Игрок мог улететь камерой в пустоту за картой и отдавать
// юнитам приказы туда же.
//
// Подход:
//  1) Камера НЕ патчится точечно в каждом месте, где её двигают (их
//     несколько, и будущий код может добавить ещё) — вместо этого
//     ЦЕНТРАЛИЗОВАННЫЙ кламп прямо перед каждой отрисовкой, оборачивая
//     render() (08-render.js). Это единственная точка, которая гарантированно
//     отрабатывает каждый кадр независимо от ТОГО, что именно подвинуло
//     камеру в этом тике — драг, клавиши или future-код.
//  2) Юниты — clampToMapBounds() (уже существует, введена в
//     21-ai-base-strategy.js для построек ИИ) переиспользуется здесь для
//     ЦЕЛИ движения: оборачиваем setUnitDestination (03-pathfinding.js),
//     единую точку входа для игрока, вражеского ИИ и attack-move — любой
//     приказ дойти до точки за картой обрезается до ближайшей точки НА
//     карте, дальше юнит идёт туда как обычно через A*.
//  3) Видимая стена по периметру — рисуется НЕ отдельным вторым проходом
//     после render() (это было бы рассинхронизировано с shake-тряской
//     камеры, см. FX.shake/ctx.translate в render(), и координатно неверно
//     — весь мир внутри render() рисуется в "дозумовых" координатах через
//     worldToScreen(), а не в сырых мировых px, см. 02-utils-canvas.js), а
//     встроена ВНУТРЬ существующего кадра через обёртку drawFogOverlay()
//     — последнего вызова внутри render() (08-render.js), уже находящегося
//     в нужном save/scale/shake-контексте. Рисуется ДО тумана, чтобы туман
//     по-прежнему скрывал неразведанные участки стены, как и остальную карту.
// Подключать ПОСЛЕДНИМ в game.html (после 22-turret-grudge.js) — патчит
// render/setUnitDestination/drawFogOverlay, все должны быть уже объявлены.

/* ---------------------------- Геометрия ---------------------------- */

// Толщина видимой стены-полосы в мировых px. Физическая граница (клампы
// ниже) идёт по краю карты (0..mapWidthPx/mapHeightPx) — стена рисуется
// СНАРУЖИ от этой границы (в отрицательные координаты/за maxX/maxY), делая
// её заметной глазу изнутри карты, не занимая игровое пространство.
const MAP_WALL_THICKNESS = 28;

function mapBoundsPx() {
  // mapWidthPx/mapHeightPx уже объявлены в 20-corner-spawn.js — переиспользуем,
  // не дублируем формулу GameConfig.mapTilesW*tileSize в третьем месте.
  return {
    minX: 0, minY: 0,
    maxX: (typeof mapWidthPx === "function") ? mapWidthPx() : GameConfig.mapTilesW * GameConfig.tileSize,
    maxY: (typeof mapHeightPx === "function") ? mapHeightPx() : GameConfig.mapTilesH * GameConfig.tileSize,
  };
}

/* ---------------------------- 1) Кламп камеры ---------------------------- */

// Прижимает камеру так, чтобы видимая область целиком оставалась внутри
// карты. Если видимая область (сильное отдаление зумом) больше самой карты
// — центрируем по соответствующей оси, а не тащим камеру в угол (иначе на
// zoomMin вид "прыгал" бы к (0,0) вместо комфортного центрирования).
function clampCameraToMapBounds() {
  const bounds = mapBoundsPx();
  const vw = visibleWorldWidth();
  const vh = visibleWorldHeight();

  if (vw >= bounds.maxX - bounds.minX) {
    State.camera.x = bounds.minX - (vw - (bounds.maxX - bounds.minX)) / 2;
  } else {
    State.camera.x = Math.min(Math.max(State.camera.x, bounds.minX), bounds.maxX - vw);
  }

  if (vh >= bounds.maxY - bounds.minY) {
    State.camera.y = bounds.minY - (vh - (bounds.maxY - bounds.minY)) / 2;
  } else {
    State.camera.y = Math.min(Math.max(State.camera.y, bounds.minY), bounds.maxY - vh);
  }
}

(function patchRenderForCameraClamp() {
  if (typeof render !== "function") return;
  const _render = render;
  render = function () {
    clampCameraToMapBounds();
    _render();
  };
})();

/* ---------------------------- 2) Кламп цели движения юнитов ---------------------------- */

(function patchSetUnitDestinationForMapBounds() {
  if (typeof setUnitDestination !== "function") return;
  const _setUnitDestination = setUnitDestination;
  setUnitDestination = function (u, goalX, goalY) {
    const bounds = mapBoundsPx();
    const cx = Math.min(Math.max(goalX, bounds.minX), bounds.maxX);
    const cy = Math.min(Math.max(goalY, bounds.minY), bounds.maxY);
    return _setUnitDestination(u, cx, cy);
  };
})();

/* ---------------------------- 3) Видимая стена по периметру ---------------------------- */

// ВАЖНО: вызывается ИЗНУТРИ render(), уже под ctx.scale(zoom) и
// shake-translate — поэтому здесь, как и во всём остальном 08-render.js,
// нужны "дозумовые" ЭКРАННЫЕ координаты через worldToScreen(), а НЕ сырые
// мировые bounds.minX/maxX напрямую (ctx.scale масштабирует, но не
// сдвигает по позиции камеры — это отдельно делает worldToScreen, вычитая
// State.camera.x/y). Рисовать сырые мировые координаты означало бы, что
// стена оказывается на правильном месте ТОЛЬКО при camera=(0,0), и уезжает
// при любом реальном позиционировании камеры (а игрок в этой игре почти
// всегда смотрит на свою базу, а не на исходную точку координат).
function drawMapBorder() {
  const bounds = mapBoundsPx();
  const t = MAP_WALL_THICKNESS;
  const topLeft = worldToScreen(bounds.minX, bounds.minY);
  const botRight = worldToScreen(bounds.maxX, bounds.maxY);
  const innerW = botRight.x - topLeft.x;
  const innerH = botRight.y - topLeft.y;

  ctx.save();

  // Внешняя полоса — плотная, читается как физическая кромка карты.
  ctx.fillStyle = "#1a1408";
  ctx.fillRect(topLeft.x - t, topLeft.y - t, innerW + t * 2, t);              // верх
  ctx.fillRect(topLeft.x - t, botRight.y, innerW + t * 2, t);                 // низ
  ctx.fillRect(topLeft.x - t, topLeft.y, t, innerH);                          // лево
  ctx.fillRect(botRight.x, topLeft.y, t, innerH);                             // право

  // Предупреждающая штриховка (диагональные полосы) поверх полосы —
  // отрисовывается через ОДИН РАЗ закэшированный canvas-паттерн (тот же
  // приём, что и getGroundPattern() для текстуры травы выше в 08-render.js),
  // а не построчным циклом ctx.stroke() по всему периметру карты каждый
  // кадр — периметр в 10000+ px давал бы тысячи мелких отрисовок на кадр.
  const pattern = getWallStripePattern();
  if (pattern) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(topLeft.x - t, topLeft.y - t, innerW + t * 2, t);
    ctx.rect(topLeft.x - t, botRight.y, innerW + t * 2, t);
    ctx.rect(topLeft.x - t, topLeft.y, t, innerH);
    ctx.rect(botRight.x, topLeft.y, t, innerH);
    ctx.clip();
    ctx.fillStyle = pattern;
    ctx.fillRect(topLeft.x - t, topLeft.y - t, innerW + t * 2, innerH + t * 2);
    ctx.restore();
  }

  // Внутренняя граничная линия — ровно по краю игрового поля, чтобы было
  // видно точную границу, где юниты/камера останавливаются.
  ctx.strokeStyle = "rgba(230,188,58,0.6)";
  ctx.lineWidth = 2;
  ctx.strokeRect(topLeft.x, topLeft.y, innerW, innerH);

  ctx.restore();
}

// Маленький офскрин-паттерн с диагональной штриховкой — создаётся один раз
// и переиспользуется (тот же приём кэширования, что и у getGroundPattern()
// в этом же файле 08-render.js, для текстуры травы).
let _wallStripePattern = null;
function getWallStripePattern() {
  if (_wallStripePattern) return _wallStripePattern;
  const size = 20;
  const off = document.createElement("canvas");
  off.width = size; off.height = size;
  const octx = off.getContext("2d");
  octx.strokeStyle = "rgba(230,188,58,0.35)";
  octx.lineWidth = 3;
  octx.beginPath();
  octx.moveTo(-size * 0.5, size * 1.5);
  octx.lineTo(size * 1.5, -size * 0.5);
  octx.moveTo(-size * 0.5, size * 0.5);
  octx.lineTo(size * 0.5, -size * 0.5);
  octx.moveTo(size * 0.5, size * 1.5);
  octx.lineTo(size * 1.5, size * 0.5);
  octx.stroke();
  _wallStripePattern = ctx.createPattern(off, "repeat");
  return _wallStripePattern;
}

(function patchDrawFogOverlayForMapBorder() {
  if (typeof drawFogOverlay !== "function") return;
  const _drawFogOverlay = drawFogOverlay;
  drawFogOverlay = function () {
    // Стена — ДО тумана: неразведанный участок границы карты по-прежнему
    // должен быть скрыт завесой тумана, как и всё остальное на карте.
    drawMapBorder();
    _drawFogOverlay();
  };
})();

/* ---------------------------- 4) Кламп построек ИИ/игрока (доп. страховка) ----------------------------
   clampToMapBounds() (21-ai-base-strategy.js) уже применяется к точкам
   застройки ИИ ДО snapBuildingCenterToGrid — этого достаточно для
   enemyPlaceBuilding. Игрок ставит здания вручную мышью/тапом
   (10-hud.js, confirmBuildPlacement) — тот файл не в контексте этой
   правки, поэтому здесь НЕ трогается; если постройка игрока сможет
   вылезти за карту, это отдельная точка патча в 10-hud.js, не входящая в
   заявленную задачу (спавн врагов / границы камеры-юнитов / размер
   карты). */