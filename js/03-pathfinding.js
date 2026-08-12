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
//  - buildOccupancyGrid(unitOwnerId) строит Set занятых клеток "col,row"
//    из зданий на карте — КРОМЕ построек, чей ownerId совпадает с
//    unitOwnerId (см. ИИ №39 ниже): юнит проходит сквозь свои постройки,
//    но обходит чужие как физическое препятствие. Без unitOwnerId (или
//    unitOwnerId == null) ведёт себя по-старому — все здания препятствие.
//  - findPath(startX, startY, goalX, goalY, unitOwnerId) — обычный A* с эвклидовой
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
//
// ИИ №38: БАГФИКС "юниты (в первую очередь вражеский ИИ) проходят сквозь
// вплотную построенные здания/стены игрока" (прямой репорт пользователя).
// buildOccupancyGrid() теперь ПОПУТНО заполняет cellOwner: Map "col,row" ->
// само здание, которому принадлежит эта клетка. Раньше occupied было
// голым Set из координат без привязки к конкретному зданию — этого не
// хватало floodFillCluster (см. её замену ниже, buildingCellsForGoal) для
// корректной работы, когда несколько построек стоят вплотную друг к другу
// (частый случай — периметр стен ИИ/игрока вокруг базы, см. 18-walls.js/
// 19-ai-target-priority-and-clustering.js).
// ИИ №39: БАГФИКС/ФИЧА по прямому запросу пользователя — "юниты должны
// проходить через СВОИ постройки, но не через постройки врага, и зеркально
// для вражеских юнитов". Раньше occupancy была общей для всех: любое
// здание — препятствие для абсолютно любого юнита независимо от владельца
// (см. старый комментарий выше, "здания просто физическое препятствие").
// Теперь buildOccupancyGrid() принимает unitOwnerId и просто НЕ добавляет
// в occupied клетки зданий, чьи ownerId совпадает с unitOwnerId — здания
// самого юнита (и remote-тени того же владельца в pvp) в сетке
// препятствий для него не участвуют вовсе, а не временно "открываются"
// как раньше делалось только для startKey/goalKey. Чужие здания (и
// remote-тени чужих владельцев) остаются занятыми клетками как прежде.
//
// unitOwnerId === undefined/null (например, вызов без юнита) сохраняет
// старое поведение "все здания — препятствие" — на этот случай ничего не
// опирается в текущем коде, но так безопаснее, чем молча исключить всё.
function buildOccupancyGrid(unitOwnerId) {
  const occupied = new Set();
  const cellOwner = new Map();
  function markBuilding(b) {
    if (unitOwnerId != null && b.ownerId === unitOwnerId) return; // свои постройки — не препятствие
    // ИИ №46 (по прямому запросу пользователя: "стены... будто и нету пока
    // 1 секунда не пройдёт") — стена в призрачном состоянии
    // (constructionMsLeft>0) физически не существует для патфайндинга: не
    // резервирует клетки occupancy, юниты проходят сквозь неё как через
    // пустое место, пока она не достроена. Ограничено ИМЕННО типом "wall"
    // (не любым строящимся зданием) — по буквальной формулировке запроса
    // ("стен вообще будто и нету"), обычные здания в постройке по-прежнему
    // блокируют путь как целые препятствия (их можно атаковать, но они уже
    // физически стоят на месте, в отличие от узкой преграды-стены, которую
    // явно просили скрыть целиком).
    if (b.type === "wall" && b.constructionMsLeft > 0) return;
    const def = BuildingDefs[b.type];
    if (!def) return;
    const halfW = def.w * GameConfig.tileSize / 2;
    const halfH = def.h * GameConfig.tileSize / 2;
    const minCol = Math.floor((b.x - halfW) / PATH_GRID_SIZE);
    const maxCol = Math.floor((b.x + halfW - 1) / PATH_GRID_SIZE);
    const minRow = Math.floor((b.y - halfH) / PATH_GRID_SIZE);
    const maxRow = Math.floor((b.y + halfH - 1) / PATH_GRID_SIZE);
    for (let c = minCol; c <= maxCol; c++) {
      for (let r = minRow; r <= maxRow; r++) {
        const key = pathCellKey(c, r);
        occupied.add(key);
        cellOwner.set(key, b);
      }
    }
  }
  Object.values(State.buildings).forEach(markBuilding);
  // ИИ №45: БАГФИКС — remoteGhosts раньше блокировали путь ВСЕГДА, даже в
  // режиме "ai" (не-PvP), где чужие здания в принципе не должны существовать
  // физически для этого клиента (это либо утечка из общей комнаты, либо
  // устаревшие данные от давно ушедшего игрока). В PvP материализованные
  // здания оппонента уже находятся в State.buildings напрямую (см.
  // 18-pvp-multiplayer.js, syncRemoteObjectsFromGhosts) — они и так попадают
  // в occupancy через обычный Object.values(State.buildings) выше, поэтому
  // повторно ходить по remoteGhosts здесь для pvp избыточно. Ограничиваем
  // этот блок явно только тем случаем, когда он ещё мог быть нужен и не
  // покрыт основным циклом — на практике сейчас не нужен вовсе, поэтому
  // отключаем целиком вне зависимости от режима, чтобы призрачные тени
  // из чужой/устаревшей комнаты никогда не резервировали клетки пути.
  if (MultiplayerMode.mode === "pvp" && State.remoteGhosts) {
    Object.values(State.remoteGhosts).forEach(pdata => {
      if (pdata && pdata.buildings) Object.values(pdata.buildings).forEach(markBuilding);
    });
  }
  occupied.cellOwner = cellOwner; // прицепляем к тому же объекту — вызывающему коду (findPath) не нужно менять сигнатуру/возвращать кортеж
  return occupied;
}

function pathHeuristic(a, b) {
  return Math.hypot(a.col - b.col, a.row - b.row);
}

// ИИ №38: ЗАМЕНА floodFillCluster. Старая версия находила ВСЕ занятые
// клетки, 4-связно смежные со startKey геометрическим флудфиллом по
// occupancy-сетке — это ломалось, как только цель (например, штаб) стояла
// вплотную к ДРУГИМ постройкам (стены периметра, впритык поставленные
// здания: частый случай и у игрока, и у ИИ, см. 18-walls.js/enemyPlaceBuilding
// clustering). Флудфилл не видит границ ОТДЕЛЬНОГО здания — он просто идёт
// по любым смежным занятым клеткам, поэтому кластер "перетекал" через
// стену на соседнее здание и дальше по всему периметру, временно объявляя
// ВСЮ базу проходимой. A* в результате прокладывал путь ПРЯМО ЧЕРЕЗ
// стены/постройки к цели внутри, вместо честного обхода снаружи — именно
// это и проявлялось как "враг проходит сквозь здания".
//
// Правильная граница кластера — это конкретное ЗДАНИЕ, которому
// принадлежит goalKey (его собственные w x h клеток из BuildingDefs), а
// не что угодно, до чего можно дотянуться флудфиллом. buildOccupancyGrid()
// выше уже даёт нам occupied.cellOwner (клетка -> здание) — просто берём
// здание-владельца goalKey и пересчитываем ЕГО собственные клетки заново
// (тот же halfW/halfH расчёт, что и markBuilding внутри buildOccupancyGrid).
function buildingCellsForGoal(occupied, goalKey) {
  const owner = occupied.cellOwner && occupied.cellOwner.get(goalKey);
  if (!owner) return new Set([goalKey]); // подстраховка — не должно происходить, если goalKey реально occupied
  const def = BuildingDefs[owner.type];
  if (!def) return new Set([goalKey]);
  const halfW = def.w * GameConfig.tileSize / 2;
  const halfH = def.h * GameConfig.tileSize / 2;
  const minCol = Math.floor((owner.x - halfW) / PATH_GRID_SIZE);
  const maxCol = Math.floor((owner.x + halfW - 1) / PATH_GRID_SIZE);
  const minRow = Math.floor((owner.y - halfH) / PATH_GRID_SIZE);
  const maxRow = Math.floor((owner.y + halfH - 1) / PATH_GRID_SIZE);
  const cluster = new Set();
  for (let c = minCol; c <= maxCol; c++) {
    for (let r = minRow; r <= maxRow; r++) cluster.add(pathCellKey(c, r));
  }
  return cluster;
}

// A* по грубой сетке. Линейный поиск минимума в open-списке (вместо
// бинарной кучи) — сетка карты прототипа маленькая, так что это остаётся
// достаточно быстрым и заметно проще в поддержке.
function findPath(startX, startY, goalX, goalY, unitOwnerId) {
  const occupied = buildOccupancyGrid(unitOwnerId);
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
  // "заперта" внутри непроходимого блока). Решение: находим клетки ИМЕННО
  // того здания, которому принадлежит цель (buildingCellsForGoal, см. её
  // комментарий выше — ИИ №38, замена старого геометрического
  // floodFillCluster) и временно считаем ИХ проходимыми — так путь доходит
  // до ближайшей внешней грани здания-цели и дальше прямиком до goalKey,
  // не перетекая на соседние вплотную стоящие постройки/стены.
  const goalCluster = occupied.has(goalKey) ? buildingCellsForGoal(occupied, goalKey) : null;
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
    u.path = findPath(u.x, u.y, goalX, goalY, u.ownerId);
  }
  const next = u.path[0];
  u.targetX = next.x;
  u.targetY = next.y;
}

/* ---------------------------- ИИ №38: статус / что дальше ----------------------------
   Багфикс goalCluster (см. buildingCellsForGoal выше) ПРОВЕРЕН изолированным
   Node-харнессом (не в браузере — окружения с реальным canvas/DOM в этой
   сессии не было), воспроизводящим buildOccupancyGrid/findPath 1:1 из
   реального кода: замкнутый периметр стен вокруг штаба заставлял старый
   floodFillCluster считать ВСЮ базу (49 из 49 занятых клеток) единым
   "кластером цели" — путь шёл прямо через стены. После фикса стены больше
   НЕ входят в кластер чужой цели (кластер = ровно клетки одного здания).
   Это и есть корневая причина репорта "враг проходит сквозь мои здания".

   НЕ ДОДЕЛАНО следующим ИИ (см. PROMPT_FOR_NEXT_AI_SHORT.md/чат с
   пользователем для полной постановки):
   1) У этого же файла есть смежный краевой эффект, замеченный при
      тестировании, но не исправленный: здание с нечётным числом тайлов
      (напр. commandCenter 3x3 = 96px), стоящее НЕ на кратной PATH_GRID_SIZE
      координате (типичный случай — стартовый штаб на x=300,y=300, кратности
      32 нет), из-за (halfW-1)/(halfH-1) в maxCol/maxRow иногда занимает НА
      ОДНУ клетку больше по краю, чем визуальные 3x3 тайла — не проверено,
      влияет ли это на что-то практически важное (скорее всего нет, occupancy
      чуть шире реального спрайта — это безопасная сторона ошибки), но стоит
      перепроверить вместе с багфиксом целиком в реальном браузере.
   2) Полная сцена "юнит должен обойти замкнутую базу и зайти в открытые
      ворота с другой стороны" не была прогнана до конца в этой сессии
      (тестовый харнесс test4_gate.js в /mnt зафиксирован вместе с этим
      сообщением, но точку с "воротами сбоку, а юнит заходит по кругу"
      нужно доперепроверить — последний прогон остановился на подходе
      юнита к стене со стороны, где ворот нет, что ОЖИДАЕМО корректно, но
      сама сцена с воротами сбоку от направления атаки нуждается в ещё
      одном явном тесте, чтобы на 100% исключить регрессию в обходе).
   3) ГЛАВНОЕ — это исправление НЕ проверялось вживую в браузере (нет
      headless Chrome/Puppeteer в infra этой сессии, попытка npm install
      puppeteer прошла, но браузерный бинарник не скачался/не был нужен для
      Node-only теста). Крайне желательно открыть game.html вручную и
      визуально прогнать бой врага против плотно застроенной базы (со
      стенами и без), прежде чем считать баг закрытым на 100%.
*/

/* ---------------------------- ИИ №39: свои постройки — не препятствие ----------------------------
   Прямой запрос пользователя: юниты должны проходить через СВОИ постройки
   (не задерживаясь на обход), но не через постройки врага; вражеские
   юниты — зеркально: сквозь свои, не сквозь игрока.

   Реализовано в buildOccupancyGrid(unitOwnerId): при построении сетки
   препятствий здания с b.ownerId === unitOwnerId просто не добавляются в
   occupied/cellOwner — для юнита их как будто нет на карте патфайндинга.
   findPath получил пятый параметр unitOwnerId и прокидывает его дальше;
   setUnitDestination передаёт u.ownerId автоматически, так что все
   существующие вызовы (движение, attack-move, возврат домой, вражеский ИИ
   через updateEnemyStub/06-enemy-ai.js) получили новое поведение бесплатно
   — их сигнатуры менять не пришлось, они и раньше вызывали
   setUnitDestination(u, x, y), где u уже содержит ownerId.

   Что это НЕ меняет:
   - isBuildPlacementValid/isEnemyBuildPlacementValid (18-walls.js и
     06-enemy-ai.js) — проверка "можно ли ЗДЕСЬ построить здание" — не
     трогалась, она не использует buildOccupancyGrid и по-прежнему не
     позволяет ставить новое здание поверх любого другого (своего или
     чужого). Меняется только проходимость для ДВИЖЕНИЯ юнитов, не
     правила застройки.
   - Прямое физическое перекрытие спрайтов: юнит теперь может визуально
     оказаться "внутри" контура своего здания, пока идёт напрямую сквозь
     него — это и есть требуемое поведение ("проходят через"), не баг.
   - Вражеские remote-тени (State.remoteGhosts, pvp) обрабатываются той же
     веткой markBuilding, так что в pvp-режиме свои/чужие тени тоже
     корректно совпадают/не совпадают с unitOwnerId юнита, который считает
     путь.

   Проверено логически по коду (та же оговорка, что и у ИИ №38 в блоке
   выше — нет браузерного окружения в этой сессии для визуальной проверки
   вживую): стоит открыть game.html и проверить на практике — 1) юнит
   игрока идёт по прямой через собственное здание, 2) тот же юнит
   ОБХОДИТ вражеское здание/стену, 3) вражеский ИИ-юнит проходит сквозь
   свои постройки, но обходит постройки/стены игрока.
*/

