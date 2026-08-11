/* ---------------------------- Патфайндинг (ИИ №7) ---------------------------- */
// TODO-пункт №1 из футера файла: юниты раньше шли строго по прямой к
// targetX/targetY, игнорируя здания — застревали у застройки. Теперь
// движение идёт по маршруту (u.path — массив мировых точек), построенному
// A* по грубой сетке тайлов, где занятые зданиями клетки — препятствия.
//
// Модель:
//  - PATH_GRID_SIZE — размер клетки сетки патфайндинга в мировых px.
//    Сделан отдельным от tileSize отрисовки/fogTileSize по тем же
//    причинам: сетку поиска пути дешевле держать грубее, чем визуальную.
//  - buildOccupancyGrid() строит Set занятых клеток "col,row" из ВСЕХ
//    зданий на карте (свои + вражеские + remote-тени других игроков) —
//    юнит обходит любую постройку независимо от владельца, как в
//    большинстве RTS (здания просто физическое препятствие).
//  - findPath(startX, startY, goalX, goalY) — обычный A* с эвклидовой
//    эвристикой по 8-связной сетке (диагонали стоят дороже прямых шагов,
//    срезание углов между двумя занятыми клетками запрещено).
//    Если старт/цель попадают в занятую клетку (юнит уже внутри здания
//    или цель — на постройке), эта клетка временно считается проходимой,
//    иначе A* никогда не найдёт путь наружу/внутрь.
//  - setUnitDestination(u, goalX, goalY) — единая точка входа: считает
//    путь один раз при назначении цели (не каждый тик — пересчёт на
//    каждый tick для десятков юнитов был бы заметно дороже) и кладёт
//    результат в u.path, выставляя u.targetX/targetY на первую точку
//    маршрута. Блок движения в gameTick, дойдя до очередной точки path,
//    просто берёт следующую.
//  - Если путь не найден за разумное число шагов (например, цель
//    полностью отрезана постройками) — возвращаем путь до ближайшей
//    достигнутой точки, чтобы юнит хотя бы не замирал молча; это
//    крайний случай для прототипа, не полноценная гарантия связности.

const PATH_GRID_SIZE = 32; // px на клетку сетки патфайндинга

function pathCellKey(col, row) {
  return col + "," + row;
}

function worldToPathCell(x, y) {
  return { col: Math.floor(x / PATH_GRID_SIZE), row: Math.floor(y / PATH_GRID_SIZE) };
}

function pathCellToWorldCenter(col, row) {
  return { x: col * PATH_GRID_SIZE + PATH_GRID_SIZE / 2, y: row * PATH_GRID_SIZE + PATH_GRID_SIZE / 2 };
}

// Строит множество занятых клеток из зданий (локальных + remote-теней).
// Пересчитывается на каждый вызов findPath — для прототипа с десятком
// зданий это дёшево; если зданий станет много, стоит кэшировать и
// инвалидировать только при постройке/разрушении.
function buildOccupancyGrid() {
  const occupied = new Set();
  function markBuilding(b) {
    const def = BuildingDefs[b.type];
    if (!def) return;
    const halfW = def.w * GameConfig.tileSize / 2;
    const halfH = def.h * GameConfig.tileSize / 2;
    const minCol = Math.floor((b.x - halfW) / PATH_GRID_SIZE);
    const maxCol = Math.floor((b.x + halfW - 1) / PATH_GRID_SIZE);
    const minRow = Math.floor((b.y - halfH) / PATH_GRID_SIZE);
    const maxRow = Math.floor((b.y + halfH - 1) / PATH_GRID_SIZE);
    for (let c = minCol; c <= maxCol; c++) {
      for (let r = minRow; r <= maxRow; r++) occupied.add(pathCellKey(c, r));
    }
  }
  Object.values(State.buildings).forEach(markBuilding);
  if (State.remoteGhosts) {
    Object.values(State.remoteGhosts).forEach(pdata => {
      if (pdata && pdata.buildings) Object.values(pdata.buildings).forEach(markBuilding);
    });
  }
  return occupied;
}

function pathHeuristic(a, b) {
  return Math.hypot(a.col - b.col, a.row - b.row);
}

// Находит все занятые клетки, 4-связно смежные с startKey (обычный
// случай — все клетки одного здания). Нужно, чтобы разрешить временный
// проход через ВСЁ здание-цель, а не только через его центральную
// клетку — иначе многоклеточные здания (2x2, 3x3 и крупнее) были бы
// физически недостижимы для приказа "атаковать это здание".
function floodFillCluster(occupied, startKey) {
  const cluster = new Set([startKey]);
  const queue = [startKey];
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
  while (queue.length > 0) {
    const key = queue.pop();
    const [c, r] = key.split(",").map(Number);
    for (const [dc, dr] of DIRS) {
      const nkey = pathCellKey(c + dc, r + dr);
      if (occupied.has(nkey) && !cluster.has(nkey)) {
        cluster.add(nkey);
        queue.push(nkey);
      }
    }
  }
  return cluster;
}

// A* по грубой сетке. Линейный поиск минимума в open-списке (вместо
// бинарной кучи) — сетка карты прототипа маленькая, так что это остаётся
// достаточно быстрым и заметно проще в поддержке.
function findPath(startX, startY, goalX, goalY) {
  const occupied = buildOccupancyGrid();
  const start = worldToPathCell(startX, startY);
  const goal = worldToPathCell(goalX, goalY);
  const startKey = pathCellKey(start.col, start.row);
  const goalKey = pathCellKey(goal.col, goal.row);

  if (startKey === goalKey) return [{ x: goalX, y: goalY }];

  // Старт/цель могут физически лежать в занятой клетке (юнит уже там,
  // либо цель — здание, к которому мы идём атаковать). Проблема: если
  // цель — здание крупнее 1x1, разрешить только саму goalKey бесполезно —
  // клетки, соседствующие с ней внутри того же здания, всё ещё заняты,
  // и A* физически не может дойти ДО goalKey ни с одной стороны (она
  // "заперта" внутри непроходимого блока). Решение: находим весь связный
  // кластер занятых клеток, к которому принадлежит цель (обычно это ровно
  // клетки одного здания), и временно считаем ВЕСЬ этот кластер проходимым
  // — так путь доходит до ближайшей внешней грани здания и дальше прямиком
  // до goalKey, не даёт обходных ложных тупиков.
  const goalCluster = occupied.has(goalKey) ? floodFillCluster(occupied, goalKey) : null;
  const passable = (key) => !occupied.has(key) || key === startKey || key === goalKey || (goalCluster && goalCluster.has(key));

  const maxCol = GameConfig.mapTilesW * (GameConfig.tileSize / PATH_GRID_SIZE);
  const maxRow = GameConfig.mapTilesH * (GameConfig.tileSize / PATH_GRID_SIZE);

  const NEIGHBORS = [
    { dc: 1, dr: 0, cost: 1 }, { dc: -1, dr: 0, cost: 1 },
    { dc: 0, dr: 1, cost: 1 }, { dc: 0, dr: -1, cost: 1 },
    { dc: 1, dr: 1, cost: 1.414 }, { dc: -1, dr: 1, cost: 1.414 },
    { dc: 1, dr: -1, cost: 1.414 }, { dc: -1, dr: -1, cost: 1.414 },
  ];

  const open = new Map();   // key -> node {col,row,g,f}
  const parent = new Map(); // key -> parentKey
  const closed = new Set();

  const startNode = { col: start.col, row: start.row, g: 0, f: pathHeuristic(start, goal) };
  open.set(startKey, startNode);
  parent.set(startKey, null);

  let bestKey = startKey, bestH = pathHeuristic(start, goal);
  const MAX_EXPANSIONS = 3000; // предохранитель от зависания на огромной/запертой карте
  let expansions = 0;
  let reachedGoal = false;

  while (open.size > 0 && expansions < MAX_EXPANSIONS) {
    expansions++;
    let curKey = null, cur = null;
    for (const [k, node] of open) {
      if (!cur || node.f < cur.f) { cur = node; curKey = k; }
    }
    open.delete(curKey);
    closed.add(curKey);

    const h = pathHeuristic(cur, goal);
    if (h < bestH) { bestH = h; bestKey = curKey; }
    if (curKey === goalKey) { reachedGoal = true; break; }

    for (const n of NEIGHBORS) {
      const ncol = cur.col + n.dc, nrow = cur.row + n.dr;
      if (ncol < 0 || nrow < 0 || ncol >= maxCol || nrow >= maxRow) continue;
      const nkey = pathCellKey(ncol, nrow);
      if (closed.has(nkey)) continue;
      if (!passable(nkey)) continue;
      // запрет "срезания угла" по диагонали между двумя занятыми клетками
      if (n.dc !== 0 && n.dr !== 0) {
        const sideA = pathCellKey(cur.col + n.dc, cur.row);
        const sideB = pathCellKey(cur.col, cur.row + n.dr);
        if (!passable(sideA) && !passable(sideB)) continue;
      }
      const g = cur.g + n.cost;
      const existing = open.get(nkey);
      if (!existing || g < existing.g) {
        open.set(nkey, { col: ncol, row: nrow, g, f: g + pathHeuristic({ col: ncol, row: nrow }, goal) });
        parent.set(nkey, curKey);
      }
    }
  }

  // Реконструкция пути от достигнутого узла (цель либо ближайшая к ней
  // точка, если полный путь не нашёлся) назад к старту по parent-цепочке.
  const endKey = reachedGoal ? goalKey : bestKey;
  const cellPath = [];
  let k = endKey;
  let safety = 0;
  while (k !== null && k !== undefined && safety < 5000) {
    safety++;
    const [c, r] = k.split(",").map(Number);
    cellPath.push({ col: c, row: r });
    if (k === startKey) break;
    k = parent.get(k);
  }
  cellPath.reverse();

  const worldPoints = cellPath.slice(1).map(cell => pathCellToWorldCenter(cell.col, cell.row));
  // Последней точкой ставим точную мировую цель (не центр клетки), если
  // путь реально дошёл до целевой клетки — так юнит доходит именно до
  // места клика/атаки, а не до центра тайла.
  if (reachedGoal) {
    if (worldPoints.length > 0) worldPoints[worldPoints.length - 1] = { x: goalX, y: goalY };
    else worldPoints.push({ x: goalX, y: goalY });
  }
  return worldPoints.length > 0 ? worldPoints : [{ x: goalX, y: goalY }];
}

// Единая точка назначения цели движения юниту: считает маршрут один раз
// и запускает движение по первой точке пути. Вызывается вместо прямого
// присваивания u.targetX/targetY везде, где юнит получает приказ дойти
// до мировой точки (движение, атака, добыча, attack-move, вражеский ИИ).
//
// ИИ №12: летающие юниты (UnitDefs[u.type].flying===true, см.
// js/01-config-state.js) пропускают A* целиком и идут по прямой одной
// точкой — здания-препятствия из buildOccupancyGrid() их не касаются,
// это наземная сетка. Патфайндинг для авиации в принципе не нужен: в
// прототипе нет ни рельефа высот, ни ПВО-зон, единственная преграда для
// наземных юнитов (постройки) авиацию не блокирует физически.
function setUnitDestination(u, goalX, goalY) {
  u.pathGoalX = goalX;
  u.pathGoalY = goalY;
  const def = UnitDefs[u.type];
  if (def && def.flying) {
    u.path = [{ x: goalX, y: goalY }];
  } else {
    u.path = findPath(u.x, u.y, goalX, goalY);
  }
  const next = u.path[0];
  u.targetX = next.x;
  u.targetY = next.y;
}

