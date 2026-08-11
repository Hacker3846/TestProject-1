/* ---------------------------- ИИ №31: стены ---------------------------- */
// Прямой запрос пользователя: "Стены, со здоровьем как у зданий, остальное
// сам додумай". BuildingDefs.wall уже добавлен в 01-config-state.js (data
// only, тем же способом, что все остальные записи таблицы — не через
// патч-приём). Этот файл добавляет ВСЁ, что требует реального кода:
//  1) форма стены в drawBuildingShape (08-render.js) — сейчас любой тип
//     без явного case проваливается в дефолтный "скруглённый
//     прямоугольник + панельные линии", что для узкой полосы 1x0.35
//     тайла выглядело бы как случайно урезанное здание, а не как стена;
//  2) вражеский ИИ достраивает стены по периметру своей базы — сама база
//     (isEnemyBuildPlacementValid/enemyPlaceBuilding, 06-enemy-ai.js) уже
//     умеет строить любой тип по BuildingDefs, но НИЧЕГО не решает САМО
//     строить стены (enemyEconomyStep не знает о них) — этот файл решает,
//     КОГДА и ГДЕ именно стены, отдельной функцией enemyWallStep(),
//     вызываемой патчем поверх updateEnemyStub (приём "переопределение
//     после объявления", как 13b/14/15/16/17 — см. правила в начале
//     PROMPT_FOR_NEXT_AI_SHORT.md, "новую фичу чаще делают отдельным
//     файлом");
//  3) иконка кнопки в HUD (16-tech-unlock.js уже читает buildingIconGlyph
//     как обычную функцию, не патч — просто дополняем её glyphs-таблицу
//     напрямую, это не переопределение чужой логики, а данные).
//
// Механика (додумано самостоятельно, раз пользователь явно это разрешил):
//  - Стена НЕ атакует и НЕ производит юнитов — чистая физическая преграда.
//    Юниты и патфайндинг уже обходят её как любое другое здание —
//    ничего дополнительно чинить не нужно (occupancy-сетка/коллизии в
//    03-pathfinding.js и isBuildPlacementValid/isEnemyBuildPlacementValid
//    работают по BuildingDefs[type].w/h универсально для ЛЮБОГО типа,
//    стена этой универсальностью просто пользуется бесплатно).
//  - Игрок строит стены вручную тем же build-режимом, что и остальные
//    здания (buildBuildBar уже рисует ВСЕ ключи BuildingDefs кроме
//    commandCenter — см. 16-tech-unlock.js, wall подхватится сам, без
//    дополнительной правки цикла).
//  - ИИ строит стены отдельно от общего enemyEconomyStep-приоритета
//    (тот отвечает за "какое ОДНО следующее здание строить" и рано
//    завершается через return на каждом приоритете) — стены нужны
//    МНОЖЕСТВЕННО (периметр, не одно здание), поэтому это отдельный шаг,
//    вызываемый каждый decision-тик НЕЗАВИСИМО от фазы FSM (как
//    enemyDefendBaseStep) — оборонительная постройка не должна ждать
//    своей очереди в ECONOMY/BUILDUP/ATTACK/REGROUP.

// ИИ №33 (правка пользователя: "стены должны быть квадратными, как в Clash
// of Clans, и связанными друг с другом"): раньше стена была узкой полосой
// (BuildingDefs.wall.w:1,h:0.35, см. 01-config-state.js) с "кирпичными"
// вертикальными насечками только вдоль своей длинной стороны — при
// повороте цепочки на 90°/по диагонали (протяжка, ИИ №32) это выглядело
// как одна и та же горизонтальная планка, просто расставленная в ряд, а
// не как связный периметр-забор. Теперь: (1) сама ячейка стала квадратной
// (w:1,h:1, правка в 01-config-state.js) — одинаково смотрится с любой
// стороны; (2) эта функция определяет, есть ли ПОСТРОЕННЫЙ сосед-стена по
// каждой из 4 сторон/4 диагоналей вокруг данной стены, и не рисует
// внутреннюю грань там, где есть сосед — соседние квадраты сливаются в
// один сплошной контур без шва, как настоящая стена, а не пунктир
// отдельных плиток. Диагональные соседи учитываются отдельной насечкой в
// углу (протяжка ИИ №32 умеет строить по диагонали — угловой стык должен
// тоже визуально "схватываться", не только ортогональный).
function wallNeighborsWorld(wx, wy) {
  const step = (typeof wallChainStepLength === "function") ? wallChainStepLength()
    : BuildingDefs.wall.w * GameConfig.tileSize;
  const tol = step * 0.35; // допуск на неточное совпадение координат соседней стены
  const dirs = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
    { dx: 1, dy: 1 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
  ];
  const found = { N: false, S: false, E: false, W: false, NE: false, NW: false, SE: false, SW: false };
  const buildings = Object.values(State.buildings);
  for (const b of buildings) {
    if (b.type !== "wall") continue;
    const ddx = b.x - wx, ddy = b.y - wy;
    const dist = Math.hypot(ddx, ddy);
    if (dist < step * 0.5 || dist > step * 1.5) continue; // сама стена или слишком далеко
    const ang = Math.atan2(ddy, ddx);
    const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const k = Math.round(snapped / (Math.PI / 4)); // atan2 -> k в диапазоне -4..4 (screen y-down: dy>0 = юг/S)
    if (k === 0) found.E = true;
    else if (Math.abs(k) === 4) found.W = true;
    else if (k === 2) found.S = true;
    else if (k === -2) found.N = true;
    else if (k === 1) found.SE = true;
    else if (k === -1) found.NE = true;
    else if (k === 3) found.SW = true;
    else if (k === -3) found.NW = true;
  }
  return found;
}

// ИИ №34 (правка пользователя: "щель у стен ещё есть — если она маленькая
// (0-10px), там должна аккуратно вставать заглушка"): wallNeighborsWorld
// выше отвечает только "есть ли сосед в этом направлении" (да/нет, с
// широким допуском step*0.5..step*1.5) и на основе этого прячет грань —
// но сами квадраты рисуются строго в размер def.w/h, а центры соседних
// стен цепочки стоят на расстоянии wallChainStepLength() (шаг цепочки,
// см. ниже), который может быть чуть больше самой плитки (запас нужен,
// чтобы соседние коллайдеры не считались "перекрывающимися" в
// isBuildPlacementValid, 10-hud.js) — отсюда щель между визуальными
// квадратами даже там, где грань уже скрыта как "нет шва".
//
// Эта функция считает ТОЧНЫЙ зазор край-в-край (не по допуску, а по
// реальной дистанции между центрами минус полная ширина/высота обеих
// плиток) для 4 ортогональных соседей и возвращает список направлений,
// которые нужно "заштопать" заглушкой — но ТОЛЬКО если реальный зазор
// положительный (иначе нечего штопать — плитки уже впритык/перекрываются)
// и не больше WALL_GAP_FILL_MAX (по прямому запросу пользователя —
// маленькая щель до ~10px закрывается заглушкой, большая — нет: это
// означало бы, что стены не образуют одну линию, а просто оказались рядом
// на большом расстоянии, и заглушка выглядела бы как случайный плавающий
// кусок посреди пустоты).
const WALL_GAP_FILL_MAX = 10; // px — верхняя граница "маленькой" щели, которую аккуратно закрываем заглушкой
function wallGapFillsWorld(wx, wy) {
  const def = BuildingDefs.wall;
  const w = def.w * GameConfig.tileSize, h = def.h * GameConfig.tileSize;
  const fills = []; // {dx, dy, gap} — dx/dy: направление к соседу (1/-1/0), gap: точный зазор край-в-край, px

  const buildings = Object.values(State.buildings);
  for (const b of buildings) {
    if (b.type !== "wall") continue;
    const ddx = b.x - wx, ddy = b.y - wy;
    const adx = Math.abs(ddx), ady = Math.abs(ddy);

    // ортогональный сосед по X (восток/запад): почти на той же высоте
    // (ady совсем маленькая — допуск в четверть высоты плитки, иначе это
    // диагональный сосед, а не боковой) — зазор МЕЖДУ КРАЯМИ считается как
    // "расстояние между центрами минус полная ширина плитки" (если центры
    // дальше друг от друга, чем сама ширина — между ними есть просвет
    // ровно такой ширины).
    if (ady < h * 0.25 && adx > 0.01) {
      const gap = adx - w;
      if (gap > 0 && gap <= WALL_GAP_FILL_MAX) {
        fills.push({ dx: ddx > 0 ? 1 : -1, dy: 0, gap });
      }
    }
    // ортогональный сосед по Y (север/юг) — симметрично X-случаю выше.
    if (adx < w * 0.25 && ady > 0.01) {
      const gap = ady - h;
      if (gap > 0 && gap <= WALL_GAP_FILL_MAX) {
        fills.push({ dx: 0, dy: ddy > 0 ? 1 : -1, gap });
      }
    }
  }
  return fills;
}

(function patchWallRenderShape() {
  if (typeof drawBuildingShape !== "function") return;

  // ИИ №31/№33: НЕ трогаю сам drawBuildingShape (риск конфликта со
  // следующим ИИ/порядком патчей) — оборачиваю: если тип "wall", рисуем
  // свою форму и выходим; иначе отдаём управление оригиналу без изменений.
  const _drawBuildingShape = drawBuildingShape;
  drawBuildingShape = function (type, s, w, h, baseColor) {
    if (type !== "wall") { _drawBuildingShape(type, s, w, h, baseColor); return; }

    const x0 = s.x - w / 2, y0 = s.y - h / 2;
    const x1 = x0 + w, y1 = y0 + h;
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, lighten(baseColor, 14));
    grad.addColorStop(1, darken(baseColor, 26));

    // world-координаты этой стены — нужны, чтобы найти соседей в
    // State.buildings и не рисовать грань/скруглённый угол там, где стена
    // продолжается дальше (связность). screenToWorld ожидает координаты в
    // том же пространстве, что и s (уже используется так же в
    // wallChainScreenToWorld/wallChainRecompute выше в этом файле).
    const world = (typeof screenToWorld === "function") ? screenToWorld(s.x, s.y) : null;
    const nb = world ? wallNeighborsWorld(world.x, world.y) : {};

    // Базовая плита — квадрат. Скругляем ТОЛЬКО углы, где нет соседа ни по
    // одной из двух смежных сторон угла (иначе скруглённый угол торчал бы
    // "откушенным" куском ровно на стыке двух построенных стен).
    const r = Math.min(4, w * 0.12);
    ctx.beginPath();
    const rNW = nb.N || nb.W ? 0 : r;
    const rNE = nb.N || nb.E ? 0 : r;
    const rSE = nb.S || nb.E ? 0 : r;
    const rSW = nb.S || nb.W ? 0 : r;
    ctx.moveTo(x0 + rNW, y0);
    ctx.lineTo(x1 - rNE, y0);
    if (rNE) ctx.arcTo(x1, y0, x1, y0 + rNE, rNE);
    ctx.lineTo(x1, y1 - rSE);
    if (rSE) ctx.arcTo(x1, y1, x1 - rSE, y1, rSE);
    ctx.lineTo(x0 + rSW, y1);
    if (rSW) ctx.arcTo(x0, y1, x0, y1 - rSW, rSW);
    ctx.lineTo(x0, y0 + rNW);
    if (rNW) ctx.arcTo(x0, y0, x0 + rNW, y0, rNW);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // ИИ №34 (правка пользователя: маленькая щель 0-10px между соседними
    // стенами должна аккуратно закрываться заглушкой): wallGapFillsWorld
    // считает точный зазор край-в-край для ортогональных соседей. Рисуем
    // заглушку ТОЛЬКО в направлении East/South (dx>0 или dy>0) — если у
    // текущей стены есть сосед на востоке с зазором G, у ТОЙ стены этот же
    // сосед будет на западе с тем же G, и если бы обе рисовали заглушку "в
    // свою сторону", один и тот же прямоугольник зазора закрашивался бы
    // дважды (два полупрозрачных прохода дают на стыке заметно более
    // тёмную/яркую полосу, чем у остальной кладки). Рисуя только
    // "исходящие" направления E/S, каждый зазор заполняется РОВНО один
    // раз — второй (симметричный) конец того же зазора со стороны
    // соседней стены его просто пропустит (её направление к нам — W/N).
    // Цвет — тот же градиент, что и сама плита: заглушка должна читаться
    // как непрерывное продолжение бетона, а не как отдельная деталь.
    if (world) {
      const fills = wallGapFillsWorld(world.x, world.y);
      ctx.fillStyle = grad;
      for (const f of fills) {
        if (f.dx > 0) {
          // щель справа от текущей стены — узкая полоса от правого края
          // текущей плиты (x1) шириной ровно f.gap, по всей высоте плиты
          ctx.fillRect(x1, y0, f.gap, h);
        } else if (f.dy > 0) {
          // щель снизу — симметрично X-случаю, полоса по всей ширине плиты
          ctx.fillRect(x0, y1, w, f.gap);
        }
      }
    }

    // Внешний контур — рисуем ТОЛЬКО по сторонам без соседа. Там, где
    // соседняя стена уже стоит, грань не обводим совсем — визуально два
    // квадрата сливаются в один сплошной блок, без шва между ними (это и
    // есть "связанность" стены, а не отдельные плитки в ряд).
    ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (!nb.N) { ctx.moveTo(x0 + rNW, y0); ctx.lineTo(x1 - rNE, y0); }
    if (!nb.E) { ctx.moveTo(x1, y0 + rNE); ctx.lineTo(x1, y1 - rSE); }
    if (!nb.S) { ctx.moveTo(x1 - rSE, y1); ctx.lineTo(x0 + rSW, y1); }
    if (!nb.W) { ctx.moveTo(x0, y1 - rSW); ctx.lineTo(x0, y0 + rNW); }
    ctx.stroke();

    // Насечки "кирпичной кладки" — сетка коротких штрихов внутри квадрата
    // (не только вдоль одной оси, как раньше у узкой полосы), плюс
    // диагональная насечка в углу, где есть диагональный сосед (NE/NW/SE/
    // SW) — читается как продолжение забора и по диагональному стыку,
    // не только по прямой линии.
    ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.lineWidth = 1;
    const cols = Math.max(2, Math.round(w / 11));
    const rows = Math.max(2, Math.round(h / 11));
    for (let i = 1; i < cols; i++) {
      const nx = x0 + (w / cols) * i;
      ctx.beginPath(); ctx.moveTo(nx, y0 + h * 0.12); ctx.lineTo(nx, y1 - h * 0.12); ctx.stroke();
    }
    for (let j = 1; j < rows; j++) {
      const ny = y0 + (h / rows) * j;
      ctx.beginPath(); ctx.moveTo(x0 + w * 0.12, ny); ctx.lineTo(x1 - w * 0.12, ny); ctx.stroke();
    }
    if (nb.NE) { ctx.beginPath(); ctx.moveTo(x1 - w * 0.2, y0); ctx.lineTo(x1, y0 + h * 0.2); ctx.stroke(); }
    if (nb.NW) { ctx.beginPath(); ctx.moveTo(x0 + w * 0.2, y0); ctx.lineTo(x0, y0 + h * 0.2); ctx.stroke(); }
    if (nb.SE) { ctx.beginPath(); ctx.moveTo(x1 - w * 0.2, y1); ctx.lineTo(x1, y1 - h * 0.2); ctx.stroke(); }
    if (nb.SW) { ctx.beginPath(); ctx.moveTo(x0 + w * 0.2, y1); ctx.lineTo(x0, y1 - h * 0.2); ctx.stroke(); }

    // акцентная окантовка, как у остальных типов (BuildingAccent) — только
    // по сторонам без соседа, той же логикой связности, что и основной
    // контур выше.
    const accent = BuildingAccent && BuildingAccent.wall;
    if (accent) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (!nb.N) { ctx.moveTo(x0 + 2 + rNW, y0 + 1); ctx.lineTo(x1 - 2 - rNE, y0 + 1); }
      if (!nb.E) { ctx.moveTo(x1 - 1, y0 + 2 + rNE); ctx.lineTo(x1 - 1, y1 - 2 - rSE); }
      if (!nb.S) { ctx.moveTo(x1 - 2 - rSE, y1 - 1); ctx.lineTo(x0 + 2 + rSW, y1 - 1); }
      if (!nb.W) { ctx.moveTo(x0 + 1, y1 - 2 - rSW); ctx.lineTo(x0 + 1, y0 + 2 + rNW); }
      ctx.stroke();
      ctx.restore();
    }
  };

  // Акцентный цвет роли — каменно-серый, отличим от боевой турели
  // (красноватый) и от прочих экономических/производственных построек.
  if (typeof BuildingAccent === "object" && BuildingAccent && !BuildingAccent.wall) {
    BuildingAccent.wall = "#7a7a72";
  }
})();

// ИИ №31: вражеский ИИ строит стены по периметру своей базы. Целевое
// число стен растёт вместе с общим "весом" базы (кол-во построек ИИ) —
// чем крупнее база, тем больше периметра нужно прикрыть; без верхнего
// разумного предела ИИ гонялся бы за стенами бесконечно и топил бы в них
// весь доход, который иначе шёл бы на армию, поэтому кап ниже.
// ПРАВКА (по прямому запросу пользователя: "закрыл полностью базу стенами
// ...не оставляя зазора между заборами") — старые значения (0.6 стены на
// здание, кап 10) считались под старую логику "декоративного кольца
// фиксированного радиуса" (ИИ №31), где периметр не зависел от реального
// bounding box построек. После ИИ №35 стены обводят ФАКТИЧЕСКИЙ прямоугольник
// вокруг базы (enemyWallStepClustered, 19-...js) — периметр такого
// прямоугольника обычно требует куда больше 10 сегментов, иначе он просто
// не может замкнуться целиком и остаются разрывы. enemyWallTarget() теперь
// оценивает НЕ долю от числа зданий, а реальную длину периметра bounding
// box (см. ниже) — это единственный способ гарантировать "без зазоров"
// независимо от того, насколько плотно/просторно расставлены здания.
const ENEMY_WALL_TARGET_CAP = 90;           // достаточно высокий потолок, чтобы не резать реальный периметр компактной базы
const ENEMY_WALL_TARGET_PER_BUILDING = 0.6; // фолбэк-эвристика, используется только если геометрические хелперы 19-...js недоступны (см. enemyWallTarget ниже)
const ENEMY_WALL_RING_RADIUS = 260;         // чуть шире обычного кольца застройки (140-220, см. enemyPlaceBuilding) — стены снаружи прочих зданий, а не между ними
const ENEMY_WALL_RING_SPREAD = 70;

// ПРАВКА (по прямому запросу пользователя: "закрыл полностью базу стенами
// ...не оставляя зазора между заборами") — раньше цель считалась грубой
// эвристикой "0.6 стены на здание", никак не связанной с РЕАЛЬНЫМ размером
// периметра, который нужно обвести. На компактной базе (после сжатия колец
// в 21-ai-base-strategy.js) периметр стал меньше, но всё равно эвристика
// по числу зданий может как занижать (мало построек, но они раскиданы
// шире margin) так и завышать цель. Честный способ — посчитать РЕАЛЬНОЕ
// число точек периметра тем же алгоритмом, которым его потом и строят
// (computeWallPerimeterPoints/enemyBuildingsBoundingBox, 19-...js,
// подключается позже и переопределяет обе эти функции глобально) — тогда
// target всегда точно равен "сколько сегментов нужно, чтобы замкнуть
// периметр целиком", без произвольного зазора по вине эвристики.
// Фолбэк на старую эвристику (buildingCount * 0.6) — на случай, если
// 19-...js почему-то не подключён (эти хелперы тогда не существуют) —
// лучше грубая оценка, чем полное отсутствие стен.
function enemyWallTarget() {
  const hasGeometryHelpers = typeof enemyBuildingsBoundingBox === "function"
    && typeof computeWallPerimeterPoints === "function"
    && typeof wallStepLengthSafe === "function";
  if (hasGeometryHelpers) {
    const box = enemyBuildingsBoundingBox();
    if (!box) return 0; // ещё нет ни одного небоевого здания — периметру нечего обводить
    const step = wallStepLengthSafe();
    const points = computeWallPerimeterPoints(box, WALL_PERIMETER_MARGIN, step);
    return Math.min(ENEMY_WALL_TARGET_CAP, points.length);
  }
  const buildingCount = enemyBuildings().filter(b => b.type !== "wall").length;
  return Math.min(ENEMY_WALL_TARGET_CAP, Math.round(buildingCount * ENEMY_WALL_TARGET_PER_BUILDING));
}

function enemyWallStep() {
  const player = State.players[enemyPlayerId];
  const hq = enemyHq();
  if (!hq) return;

  const wallCount = enemyBuildings().filter(b => b.type === "wall").length;
  const target = enemyWallTarget();
  if (wallCount >= target) return;
  if (player.credits < BuildingDefs.wall.cost) return;

  // Размещение — по кольцу ФИКСИРОВАННОГО радиуса вокруг штаба (в отличие
  // от enemyPlaceBuilding, которое расширяет кольцо наружу): стены должны
  // формировать периметр примерно ОДНОЙ дистанции от базы, а не
  // разбредаться по случайным дальним радиусам, как обычные постройки.
  // Если на этом кольце совсем нет места (плотная застройка) — просто
  // не строим в этот decision-тик, попробуем на следующем (место может
  // освободиться после разрушения чего-то или после смещения фокуса).
  for (let attempt = 0; attempt < ENEMY_PLACEMENT_RING_ATTEMPTS; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = ENEMY_WALL_RING_RADIUS + Math.random() * ENEMY_WALL_RING_SPREAD;
    const tx = hq.x + Math.cos(angle) * radius;
    const ty = hq.y + Math.sin(angle) * radius;
    if (isEnemyBuildPlacementValid("wall", tx, ty)) {
      player.credits -= BuildingDefs.wall.cost;
      const id = uid("b");
      State.buildings[id] = {
        id, ownerId: enemyPlayerId, type: "wall",
        x: tx, y: ty, hp: BuildingDefs.wall.hp, maxHp: BuildingDefs.wall.hp,
        rallyX: tx, rallyY: ty, buildQueue: [],
      };
      logMsg("Противник укрепляет периметр стеной", "enemy");
      return;
    }
  }
}

(function patchEnemyWallBuilding() {
  if (typeof updateEnemyStub !== "function") return;

  // ИИ №31: тот же приём, что уже применяет enemyDefendBaseStep — вызов
  // КАЖДЫЙ decision-тик, независимо от текущей фазы FSM (ECONOMY/BUILDUP/
  // ATTACK/REGROUP), потому что укрепление периметра — фоновая задача,
  // а не часть какой-то одной конкретной фазы. Не патчу сам updateEnemyStub
  // изнутри (риск конфликта порядка подключения, см. правила проекта) —
  // оборачиваю вызовом после оригинала.
  const _updateEnemyStub = updateEnemyStub;
  updateEnemyStub = function (dt) {
    _updateEnemyStub(dt);
    // enemyWallStep сам троттлится тем же decisionTimer-порогом, что и
    // остальной ИИ: _updateEnemyStub уже сбросил enemyFsm.decisionTimer в
    // 0 только когда decision-тик реально сработал, а не на каждый кадр —
    // но decisionTimer сброс происходит ВНУТРИ оригинала до return на
    // раннем троттлинге, так что здесь нет надёжного признака "тик
    // сработал" без дублирования его же таймера. Простое и достаточно
    // дешёвое решение: считаем собственный независимый троттлинг-таймер
    // на основе того же ENEMY_DECISION_INTERVAL — консистентно с тем, как
    // уже устроен весь остальной ИИ-модуль (каждый источник таймера сам
    // отвечает за свой троттлинг, см. enemyMatchClock/enemyFsm.decisionTimer).
    enemyWallClock.timer += dt;
    if (enemyWallClock.timer < ENEMY_DECISION_INTERVAL()) return;
    enemyWallClock.timer = 0;
    enemyWallStep();
  };
})();

const enemyWallClock = { timer: 0 };

// HUD-иконка кнопки постройки — 16-tech-unlock.js уже вызывает
// buildingIconGlyph(key) как обычную функцию с фолбэком "🏗", если ключ
// не найден в её таблице glyphs. Не патчу функцию — просто ничего не
// делаю здесь для иконки: дефолт "🏗" не различает стену среди прочих
// построек, поэтому дополняем таблицу НАПРЯМУЮ (это данные, не логика,
// buildingIconGlyph уже читает объект glyphs через замыкание один раз при
// объявлении — здесь нужен именно патч функции, т.к. glyphs объявлен
// как локальная const внутри неё и недоступна снаружи).
(function patchWallIcon() {
  if (typeof buildingIconGlyph !== "function") return;
  const _buildingIconGlyph = buildingIconGlyph;
  buildingIconGlyph = function (key) {
    if (key === "wall") return "🧱";
    return _buildingIconGlyph(key);
  };
})();

/* ---------------------------- ИИ №43: линия стен двумя пальцами ---------------------------- */
// Прямой запрос пользователя, ПОСЛЕ серии багов с механикой "зажми и веди"
// (ИИ №32/37/38/40/41/42): та механика различала "панорама | протяжка |
// одиночный клик" по таймеру удержания (WALL_CHAIN_HOLD_MS) — и раз за
// разом ломалась на реальных мобильных браузерах: контекстное меню от
// нативного long-press совпадало по времени с нашим таймером (ИИ №41),
// 09-input.js вызывал confirmBuildPlacement() на mousedown/синтетический
// mousedown ещё до решения жеста (ИИ №42), геометрия короткой протяжки
// схлопывалась в одну точку (ИИ №40). Пользователь явно попросил убрать
// этот подход целиком: "просто пропиши чтобы полоска стены ставилась
// касание в двух отрезках, а не от зажатия".
//
// НОВАЯ МЕХАНИКА (полностью заменяет предыдущую, никакого удержания):
//  - ТАЧ, один палец: обычный тап — сразу ставит ОДНУ стену в точке
//    касания (без ожидания, без таймера) — как и любое другое здание.
//  - ТАЧ, два пальца ОДНОВРЕМЕННО на #touchPanZone: как только КАСАЮТСЯ
//    ОБА пальца (второй коснулся, пока первый ещё держится) — между их
//    точками сразу строится ВСЯ линия стен (та же логика шага сетки/
//    диагоналей, что и раньше, см. computeWallChainPoints). Оба пальца не
//    обязательно поднимать — линия строится в момент появления второго
//    касания, дальнейшее движение пальцев на эту уже построенную линию не
//    влияет (см. touchmove ниже — во время удержания второй линии не
//    пересчитываем повторно, чтобы не плодить дублирующиеся стены на
//    каждый кадр движения).
//  - МЫШЬ: без изменений по сути — одиночный клик (mousedown) сразу ставит
//    одну стену в точке клика. У мыши физически один курсор, поэтому
//    двух-точечный жест для неё не применим (пользователь подтвердил, что
//    тач — главное, мышь можно оставить как есть).
//  - Как и раньше: если точка (любая из двух точек тач-жеста, или
//    единственная точка мышиного/одиночного тач-клика) совпадает с уже
//    построенной стеной поблизости — снап идёт к сетке, ЯКОРЕННОЙ на эту
//    стену (nearestWallAnchor/snapWallPointToAnchorGrid, ниже — те же
//    функции, что и раньше, не переписаны).
//  - Обычный (не-wall) режим постройки НЕ ЗАТРОНУТ — все обработчики ниже
//    сразу выходят, если State.buildMode.type !== "wall".

// Длина сегмента цепочки — фактический размер стены вдоль её длинной
// стороны (в мировых px). БАГФИКС (по прямому запросу пользователя:
// "иногда [стены] не ставятся в пустую клетку, оставляют калитки в 1
// блок зазором"): раньше здесь прибавлялся BUILD_GAP (тогда 6px), из-за
// чего шаг цепочки (32+6=38px) не был кратен GameConfig.tileSize (32px).
// Стены снапались на СВОЮ собственную сетку с шагом 38px, которая
// постепенно расходится с обычной тайловой сеткой (snapBuildingCenterToGrid,
// 02-utils-canvas.js, используется всеми ОСТАЛЬНЫМИ зданиями) — на
// коротких цепочках расхождение незаметно, но чем длиннее цепочка или чем
// дальше клик от предыдущего анкера, тем больше итоговая стена "уезжает"
// от границы клетки, на которой стоит соседняя стена/здание, и между ними
// остаётся щель ровно в несколько px (тот самый эффект "калитки"). Теперь
// шаг РОВНО равен tileSize (BUILD_GAP занулён и убран отсюда явно, не
// полагаясь на то, что константа в 10-hud.js когда-нибудь останется 0) —
// стены живут на той же самой глобальной сетке, что и все прочие здания,
// без накопления расхождения.
function nearestWallAnchor(worldPoint) {
  const step = wallChainStepLength();
  // Радиус поиска — чуть больше ДИАГОНАЛЬНОГО шага (step*sqrt(2), см.
  // computeWallChainPoints выше — с БАГФИКСОМ диагональ теперь полный step
  // по каждой оси, а не length-preserving 0.707*step), не только
  // ортогонального: иначе клик рядом со стеной, стоящей по диагонали, не
  // находил бы её как anchor и падал бы на глобальную сетку вместо
  // привязки к конкретной соседней стене (сама по себе не баг после
  // синхронизации сеток, но нарушало бы смысл функции — "приклеиться к
  // ближайшей существующей стене").
  const searchRadius = step * Math.SQRT2 * 1.1;
  const buildings = Object.values(State.buildings);
  let best = null, bestDist = Infinity;
  for (const b of buildings) {
    if (b.type !== "wall") continue;
    const dist = Math.hypot(b.x - worldPoint.x, b.y - worldPoint.y);
    if (dist < searchRadius && dist < bestDist) { best = b; bestDist = dist; }
  }
  return best;
}

// Снап точки к сетке, ЯКОРЕННОЙ на конкретной стене (anchor), а не на
// абсолютном (0,0) — гарантирует, что результат попадёт РОВНО в одну из 8
// соседних ячеек вокруг anchor (та же сетка, что и обычно, просто со
// сдвинутым началом отсчёта на anchor.x/anchor.y), т.е. строго впритык.
function snapWallPointToAnchorGrid(worldPoint, anchor) {
  const step = wallChainStepLength();
  return {
    x: anchor.x + Math.round((worldPoint.x - anchor.x) / step) * step,
    y: anchor.y + Math.round((worldPoint.y - anchor.y) / step) * step,
  };
}

// Снап точки к ЕДИНОЙ АБСОЛЮТНОЙ сетке карты (от мировых (0,0)), если
// рядом нет уже построенной стены — если есть, снапаем к сетке, якоренной
// на неё (см. выше), чтобы новая стена встала строго впритык к ней.
// БАГФИКС (та же задача, см. wallChainStepLength ниже): раньше базовый
// (без anchor) случай снапал на ЛИНИИ сетки (Math.round(x/step)*step —
// кратно 0), а обычные здания с нечётной шириной/высотой (wall — 1x1,
// нечётное по обеим осям) снапаются на ЦЕНТР клетки
// (snapBuildingCenterToGrid, 02-utils-canvas.js). Из-за этого одиночная
// стена, поставленная БЕЗ соседа рядом (первая стена цепочки, нет
// anchor), могла попасть на половину клетки в сторону от той сетки,
// на которой стоят остальные здания — следующая стена/здание, прилепленное
// к ней анкером, наследовало это смещение, и итоговая линия расходилась
// с тайловой сеткой карты. Теперь оба случая (с anchor и без) используют
// ОДНУ и ту же формулу центра клетки, что и snapBuildingCenterToGrid для
// нечётных 1x1 — единая сетка для стен и всех прочих зданий.
function snapWallPointToGrid(worldPoint) {
  const anchor = nearestWallAnchor(worldPoint);
  if (anchor) return snapWallPointToAnchorGrid(worldPoint, anchor);
  if (typeof snapBuildingCenterToGrid === "function") {
    return snapBuildingCenterToGrid("wall", worldPoint.x, worldPoint.y);
  }
  const step = wallChainStepLength();
  const ts = GameConfig.tileSize;
  return {
    x: Math.round((worldPoint.x - ts / 2) / step) * step + ts / 2,
    y: Math.round((worldPoint.y - ts / 2) / step) * step + ts / 2,
  };
}

// БАГФИКС (по прямому запросу пользователя — см. комментарий выше у
// nearestWallAnchor): шаг РОВНО равен размеру плитки стены в px, без
// добавочного BUILD_GAP — соседние стены (и стена+любое другое здание)
// стоят строго край-в-край на единой тайловой сетке, без щелей и без
// наложения (снап на сетку уже гарантирует не-пересечение, см. BUILD_GAP=0
// в 10-hud.js/06-enemy-ai.js).
function wallChainStepLength() {
  return BuildingDefs.wall.w * GameConfig.tileSize;
}

// Строит МАССИВ точек {x,y} от (x0,y0) до (x1,y1) с шагом
// wallChainStepLength(), направление округляется к одному из 8 (по x/y/
// диагонали) — так линия всегда идёт ровно горизонтально/вертикально/
// диагонально, как в CoC, а не под произвольным углом (произвольный угол
// давал бы щели между стенами или наложения).
// БАГФИКС (та же задача про "калитки" — см. wallChainStepLength выше):
// раньше диагональный шаг был stepX=stepY=cos(45°)*step (~0.707*step) —
// сохранял ДЛИНУ шага постоянной (step) независимо от направления, что
// физически верно для движения по прямой, но НЕВЕРНО для сетки квадратных
// клеток: соседняя по диагонали клетка сдвинута от текущей на ПОЛНЫЙ
// tileSize по КАЖДОЙ оси (не на 0.707*tileSize) — переход между центрами
// диагонально смежных клеток образует гипотенузу длиной tileSize*sqrt(2),
// а не tileSize. Со старой формулой диагональная цепочка "уезжала" от
// центров клеток уже на второй стене (смещение ~9.4px на клетку при
// step=32 — как раз в диапазоне, который WALL_GAP_FILL_MAX пыталась
// прятать заглушками) и НАКАПЛИВАЛА расхождение дальше по цепочке.
// Теперь и по X, и по Y шаг РОВНО tileSize (полный step), только со знаком
// направления — ортогональные шаги не меняются (один из компонентов был
// и остаётся 0), а диагональные шаги стали физически на tileSize*sqrt(2)
// длиннее по факту пройденного пути за одну "стену цепочки", зато каждая
// точка гарантированно попадает на ту же тайловую сетку центров клеток,
// на которой стоят все остальные постройки — щелей/калиток на диагонали
// больше нет.
function computeWallChainPoints(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const totalDist = Math.hypot(dx, dy);
  const step = wallChainStepLength();
  if (totalDist < 1) return [{ x: x0, y: y0 }];

  // Округляем направление до ближайшего из 8 (шаг 45°) — угол в радианах,
  // приводим к ближайшему кратному PI/4.
  const rawAngle = Math.atan2(dy, dx);
  const snappedAngle = Math.round(rawAngle / (Math.PI / 4)) * (Math.PI / 4);
  // sign(cos)/sign(sin) вместо cos/sin напрямую — направление (-1/0/1),
  // умноженное на полный step по каждой оси отдельно (см. комментарий
  // выше про диагональ клетка-в-клетку, а не length-preserving шаг).
  const dirX = Math.round(Math.cos(snappedAngle));
  const dirY = Math.round(Math.sin(snappedAngle));
  const stepX = dirX * step;
  const stepY = dirY * step;
  // Реальная длина одного шага цепочки (для ортогональных — step, для
  // диагональных — step*sqrt(2)) — используется ТОЛЬКО для подсчёта
  // количества сегментов под жест нужной длины, не для позиции точек.
  const strideLen = Math.hypot(stepX, stepY);

  // МИНИМУМ 1 шаг (2 точки), даже если totalDist меньше половины шага
  // сетки — два пальца в разных точках всегда означают "хочу минимум 2
  // стены", а не 1 (иначе жест двумя пальцами ничем не отличался бы от
  // одного тапа).
  const count = Math.max(1, Math.round(totalDist / strideLen));
  const points = [];
  for (let i = 0; i <= count; i++) {
    points.push({ x: x0 + stepX * i, y: y0 + stepY * i });
  }
  return points;
}

// Строит одну стену в мировой точке (уже снапнутой к сетке) — общий путь
// для одиночного клика мышью, одиночного тапа тачем, и как строительный
// блок для линии двух пальцев (используется в цикле wallChainCommitPoints).
// Возвращает true, если стена реально построена (валидное место + хватило
// кредитов), false иначе.
function buildSingleWall(worldPoint) {
  const player = State.players[localPlayerId];
  if (!isBuildPlacementValid("wall", worldPoint.x, worldPoint.y)) return false;
  if (player.credits < BuildingDefs.wall.cost) return false;
  player.credits -= BuildingDefs.wall.cost;
  const id = uid("b");
  State.buildings[id] = {
    id, ownerId: localPlayerId, type: "wall",
    x: worldPoint.x, y: worldPoint.y, hp: BuildingDefs.wall.hp, maxHp: BuildingDefs.wall.hp,
    rallyX: worldPoint.x, rallyY: worldPoint.y, buildQueue: [],
  };
  return true;
}

// Строит ВСЮ линию точек разом (двух-пальцевый жест) — по кредитам, от
// начала цепочки; как только кредитов не хватает на очередную точку,
// дальше не строим (не логируем каждую пропущенную точку отдельно).
// Валидность пересчитывается ПРЯМО ПЕРЕД постройкой каждой точки (не
// заранее посчитанная) — уже построенные соседние точки этой же линии
// (построенные чуть раньше в этом же проходе) должны блокировать
// повторную постройку в той же ячейке.
function wallChainCommitPoints(points) {
  let built = 0;
  for (const p of points) {
    if (buildSingleWall(p)) built++;
    else if (State.players[localPlayerId].credits < BuildingDefs.wall.cost) break;
  }
  if (built > 0) logMsg(`Построено стен: ${built}`);
  else logMsg("Стены не построены — проверьте кредиты/место", "warn");
  return built;
}

// Состояние ТЕКУЩЕГО превью — читается drawWallChainGhosts (ниже в этом
// файле, не переписана) для отрисовки призраков. Заполняется на короткое
// время между появлением второго пальца и завершением обоих касаний, затем
// сбрасывается — линия уже построена в State.buildings к этому моменту,
// дальше рисовать нечего (реальные стены рисует обычный drawBuildingShape).
const wallChainDrag = {
  active: false,
  points: [], // {x,y,valid} — только для краткого визуального превью в момент построения
};

function wallChainPreviewClear() {
  wallChainDrag.active = false;
  wallChainDrag.points = [];
}

// ИИ №43: МЫШЬ — одиночный клик сразу ставит одну стену в точке клика, без
// удержания/таймера/протяжки. Слушаем в capture-фазе, чтобы 09-input.js's
// mousedown (который иначе вызвал бы confirmBuildPlacement() для ЛЮБОГО
// типа здания, включая wall) не сработал поверх нас на то же событие —
// глушим mousedown полностью для wall здесь и строим стену сами.
viewport.addEventListener("mousedown", (e) => {
  if (!State.buildMode || State.buildMode.type !== "wall") return;
  if (e.button !== 0) return;
  const rect = viewport.getBoundingClientRect();
  const world = snapWallPointToGrid(screenToWorld(e.clientX - rect.left, e.clientY - rect.top));
  buildSingleWall(world) || logMsg("Стена не построена — проверьте кредиты/место", "warn");
  e.stopImmediatePropagation();
  e.preventDefault();
}, { capture: true });

// ИИ №43: ТАЧ — один палец — обычный тап сразу ставит одну стену (как и
// клик мышью выше). Два пальца ОДНОВРЕМЕННО — линия между ними целиком,
// строится в момент появления второго касания (пока оба пальца ещё
// держатся на экране).
(function setupWallChainTouch() {
  const panZone = document.getElementById("touchPanZone");
  if (!panZone) return;

  function rectOf() { return panZone.getBoundingClientRect(); }

  // Точка, где коснулся ПЕРВЫЙ палец (world, уже снапнутая) — нужна на
  // случай, если второй палец коснётся чуть позже (двух-пальцевый жест).
  // Если второй палец так и не появится до touchend первого — это обычный
  // одиночный тап, строим одну стену в этой же точке.
  let firstTouchWorld = null;
  let firstTouchId = null;
  let twoFingerHandled = false; // true, как только линия между двумя пальцами уже построена в этом жесте — дальнейшие touchmove/touchend не должны строить повторно

  function reset() {
    firstTouchWorld = null;
    firstTouchId = null;
    twoFingerHandled = false;
    wallChainPreviewClear();
  }

  panZone.addEventListener("touchstart", (e) => {
    if (!State.buildMode || State.buildMode.type !== "wall") return;

    if (e.touches.length === 1) {
      // Первый палец касается — запоминаем точку, НЕ строим сразу (ждём,
      // не появится ли второй палец для линии). Не поглощаем событие —
      // если второй палец не появится, обычная логика (панорама и т.п.)
      // 09-input.js всё ещё должна была бы сработать для НЕ-wall режимов,
      // но раз мы уже проверили buildMode.type==="wall" выше, здесь она нам
      // не мешает.
      const rect = rectOf();
      const touch = e.touches[0];
      firstTouchWorld = snapWallPointToGrid(screenToWorld(touch.clientX - rect.left, touch.clientY - rect.top));
      firstTouchId = touch.identifier;
      twoFingerHandled = false;
      e.preventDefault();
      return;
    }

    if (e.touches.length === 2) {
      // Второй палец коснулся, пока первый уже держится (обычный случай) —
      // ИЛИ оба пальца легли на экран практически одновременно (первый
      // touchstart сразу приходит с длиной 2, firstTouchWorld ещё не
      // успел запомниться) — оба случая обрабатываем здесь одинаково: если
      // firstTouchWorld уже есть, используем его как первую точку и берём
      // вторую из "не первого" touch; если его ещё нет — берём обе точки
      // прямо из e.touches[0]/e.touches[1].
      if (twoFingerHandled) return;
      const rect = rectOf();
      let p1World, p2World;
      if (firstTouchWorld) {
        p1World = firstTouchWorld;
        let secondTouch = null;
        for (let i = 0; i < e.touches.length; i++) {
          if (e.touches[i].identifier !== firstTouchId) { secondTouch = e.touches[i]; break; }
        }
        if (!secondTouch) secondTouch = e.touches[1]; // подстраховка, не должно случаться
        p2World = snapWallPointToGrid(screenToWorld(secondTouch.clientX - rect.left, secondTouch.clientY - rect.top));
      } else {
        const t0 = e.touches[0], t1 = e.touches[1];
        p1World = snapWallPointToGrid(screenToWorld(t0.clientX - rect.left, t0.clientY - rect.top));
        p2World = snapWallPointToGrid(screenToWorld(t1.clientX - rect.left, t1.clientY - rect.top));
      }

      const rawPoints = computeWallChainPoints(p1World.x, p1World.y, p2World.x, p2World.y);
      // Краткое превью перед постройкой — для отрисовки одним кадром (см.
      // drawWallChainGhosts); строим сразу же следом, превью носит чисто
      // визуальный характер (не ждём отдельного кадра рендера).
      wallChainDrag.active = true;
      wallChainDrag.points = rawPoints.map(p => ({ x: p.x, y: p.y, valid: isBuildPlacementValid("wall", p.x, p.y) }));

      wallChainCommitPoints(rawPoints);
      twoFingerHandled = true;
      e.preventDefault();
      return;
    }

    // Третий палец или иная комбинация — не наш случай, ничего не делаем
    // (не мешаем возможной штатной логике для других режимов, хотя мы уже
    // внутри buildMode.type==="wall" здесь).
  }, { capture: true, passive: false });

  panZone.addEventListener("touchmove", (e) => {
    if (!State.buildMode || State.buildMode.type !== "wall") return;
    // Линия уже построена по факту второго касания (touchstart) — во время
    // движения пальцев дальше ничего не пересчитываем и не строим повторно
    // (иначе на каждый кадр touchmove плодились бы новые стены). Просто
    // глушим событие, чтобы штатная панорама/рамка выделения 09-input.js не
    // среагировала на эти же пальцы поверх уже случившейся постройки.
    if (firstTouchWorld) { e.preventDefault(); }
  }, { capture: true, passive: false });

  panZone.addEventListener("touchend", (e) => {
    if (!State.buildMode || State.buildMode.type !== "wall") return;
    if (!firstTouchWorld) return;

    if (e.touches.length === 0) {
      // Последний палец поднят — если это был ОДИНОЧНЫЙ тап (второй палец
      // так и не коснулся за всё время жеста) — строим одну стену в точке
      // первого касания. Если линия уже построена двумя пальцами —
      // twoFingerHandled=true, тут ничего строить не нужно повторно.
      if (!twoFingerHandled) {
        buildSingleWall(firstTouchWorld) || logMsg("Стена не построена — проверьте кредиты/место", "warn");
      }
      reset();
    }
    e.stopImmediatePropagation();
    e.preventDefault();
  }, { capture: true, passive: false });

  panZone.addEventListener("touchcancel", () => {
    reset();
  }, { capture: true });
})();

// cancelBuildMode уже вызывается из 09-input.js (Escape/ПКМ/второй палец в
// НЕ-wall режимах) — досюда достаточно сбросить наш превью-стейт тем же
// патчем, чтобы не осталось "зависшего" превью после отмены режима извне.
(function patchCancelBuildModeForWallChain() {
  if (typeof cancelBuildMode !== "function") return;
  const _cancelBuildMode = cancelBuildMode;
  cancelBuildMode = function () {
    _cancelBuildMode();
    wallChainPreviewClear();
  };
})();

(function patchTryStartBuildingForWallChain() {
  if (typeof tryStartBuilding !== "function") return;
  const _tryStartBuilding = tryStartBuilding;
  tryStartBuilding = function (key) {
    _tryStartBuilding(key);
    if (key === "wall" && State.buildMode && State.buildMode.type === "wall") {
      logMsg("Стены: тап/клик — одна стена. Два пальца одновременно (в разных точках) — линия стен между ними.");
    }
  };
})();


// ИИ №32: отрисовка всей цепочки призраков поверх штатного одиночного
// drawBuildGhost (08-render.js, не патчу — вызывается независимо, ПОСЛЕ
// него, из патча над render ниже). Рисует прямоугольник на каждую точку
// цепочки, с тем же визуальным языком (зелёный/красный по valid), что и
// одиночный призрак — только без пульсации/анимации (цепочка может быть
// длинной, лишняя анимация на каждый сегмент была бы шумной).
function drawWallChainGhosts() {
  if (!wallChainDrag.active || wallChainDrag.points.length === 0) return;
  const def = BuildingDefs.wall;
  const w = def.w * GameConfig.tileSize, h = def.h * GameConfig.tileSize;
  ctx.save();
  wallChainDrag.points.forEach(p => {
    const s = worldToScreen(p.x, p.y);
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = p.valid ? "#2f6f4f" : "#8a2a1f";
    ctx.fillRect(s.x - w / 2, s.y - h / 2, w, h);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = p.valid ? "#6fd39f" : "#e0645a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s.x - w / 2, s.y - h / 2, w, h);
  });
  ctx.restore();
}

(function patchRenderForWallChainGhosts() {
  if (typeof render !== "function") return;
  // ИИ №32: render() (08-render.js) уже вызывает drawBuildGhost() в
  // фиксированном месте кадра (после юнитов/зданий, до фог-оверлея) — та
  // же точка в порядке отрисовки нужна и цепочке (иначе цепочка рисовалась
  // бы поверх/под туманом не синхронно с одиночным призраком). Оборачиваем
  // render целиком проще и безопаснее, чем лезть внутрь неё построчно —
  // рисуем цепочку СРАЗУ ПОСЛЕ оригинального render() (который уже
  // отрисовал одиночный ghost и фог) — цепочка окажется поверх фога, что
  // приемлемо для собственного UI-превью игрока (drawBuildGhost и так
  // всегда поверх всего, см. её место в исходном render()).
  const _render = render;
  render = function () {
    _render();
    drawWallChainGhosts();
  };
})();