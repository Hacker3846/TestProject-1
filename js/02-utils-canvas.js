/* ---------------------------- Canvas / Camera ---------------------------- */

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const viewport = document.getElementById("viewport");

// ИИ (стиль/мобайл): раньше canvas.width/height ставились в CSS-пикселях
// напрямую, что на экранах с devicePixelRatio>1 (почти все телефоны) даёт
// смазанную, "мыльную" картинку — на десктопных мониторах с dpr=1 разницы
// не было видно, поэтому баг был незаметен раньше. Теперь буфер канваса
// рисуется в РЕАЛЬНЫХ пикселях экрана (умножен на dpr), а сам канвас через
// ctx.scale растягивается обратно до логического CSS-размера — весь
// остальной код рендера по-прежнему оперирует "логическими" координатами
// canvas.width/height, как раньше, ничего в render()/worldToScreen делать
// иначе не нужно. dpr ограничен потолком 2 — на 3x телефонах экономим
// заполнение (буфер 3x на мобильном GPU уже заметно бьёт по FPS,
// а разница на глаз против 2x минимальна).
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = viewport.clientWidth;
  const cssH = viewport.clientHeight;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Начиная с этой правки, canvas.width/canvas.height в остальном коде
  // (render(), фог, culling по границам экрана) должны означать
  // ЛОГИЧЕСКИЙ размер, а не физический буфер — храним его отдельно,
  // т.к. canvas.width теперь физический (см. logicalWidth/logicalHeight ниже).
  canvas.logicalWidth = cssW;
  canvas.logicalHeight = cssH;
}
window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 60));
resizeCanvas();

/* ---------------------------- Утилиты ---------------------------- */

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function worldToScreen(x, y) {
  return { x: x - State.camera.x, y: y - State.camera.y };
}
function screenToWorld(x, y) {
  return { x: x + State.camera.x, y: y + State.camera.y };
}

// ИИ (по прямому запросу пользователя: "здания ставятся строго в клетки") —
// привязка центра здания к тайловой сетке карты (GameConfig.tileSize),
// чтобы прямоугольная область здания (w x h тайлов, см. BuildingDefs)
// ВСЕГДА совпадала с границами клеток, а не висела на произвольном
// мышином пикселе. Правило по каждой оси независимо (здания вроде
// barracks 2x3 — чётная ширина, нечётная высота — снапятся по-разному
// на x и y):
//  - чётное число тайлов по оси -> центр садится НА линию сетки (иначе
//    половина здания всегда попадала бы по разные стороны клетки);
//  - нечётное число тайлов по оси -> центр садится на ЦЕНТР клетки.
// Общая для игрока (10-hud.js/09-input.js) и вражеского ИИ (06-enemy-ai.js/
// 19-ai-target-priority-and-clustering.js) — единственный источник истины
// по геометрии сетки, чтобы обе стороны строили на одной и той же сетке.
// Стены (wall) НЕ используют эту функцию — у них с ИИ №31 своя отдельная
// система привязки (snapWallPointToGrid, 18-walls.js), заточенная под то,
// чтобы соседние стены стояли строго встык друг к другу; вызывающий код
// сам решает не звать эту функцию для key==="wall" (см. её использование).
function snapBuildingCenterToGrid(key, wx, wy) {
  const ts = GameConfig.tileSize;
  const def = typeof BuildingDefs !== "undefined" ? BuildingDefs[key] : null;
  const wTiles = def ? Math.max(1, Math.round(def.w)) : 1;
  const hTiles = def ? Math.max(1, Math.round(def.h)) : 1;
  const snapAxis = (coord, tilesCount) => (tilesCount % 2 === 0)
    ? Math.round(coord / ts) * ts
    : Math.round((coord - ts / 2) / ts) * ts + ts / 2;
  return { x: snapAxis(wx, wTiles), y: snapAxis(wy, hTiles) };
}

