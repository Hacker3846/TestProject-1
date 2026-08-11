/* ---------------------------- Фог войны (ИИ №6, линия видимости ИИ №9) ---------------------------- */
// Модель: отдельная грубая сетка клеток (fogTileSize px, независимая от
// визуальной сетки tileSize) поверх мировых координат. Каждый тик
// пересчитываем fog.visible с нуля (объединение зон обзора всех живых
// юнитов/зданий ЛОКАЛЬНОГО игрока), а всё, что попало в visible, заодно
// добавляем в fog.explored (который не уменьшается за партию).
//
// ИИ №9: раньше обзор был просто кругом без учёта препятствий (см. футер
// файла и старый комментарий тут же, TODO №1 из PROMPT_FOR_NEXT_AI.md).
// Теперь обзор считается raycasting'ом — здания блокируют линию
// видимости, поэтому просто стоять в радиусе за стеной больше не
// раскрывает то, что физически загорожено; чтобы увидеть, что за
// зданием, нужно реально его обойти. Раздельно от патфайндинга
// (js/03-pathfinding.js): там своя occupancy-сетка заточена под то,
// чтобы юнит МОГ дойти до многоклеточной цели (floodFillCluster делает
// клетки цели временно проходимыми), это не годится для видимости, где
// здание должно блокировать луч целиком без исключений. Поэтому здесь
// строится собственная простая occupancy-сетка блокираторов на основе
// fogTileSize (см. buildFogBlockerGrid), независимая от патфайндинга.

function fogKey(col, row) {
  return col + "," + row;
}

function worldToFogCell(x, y) {
  return {
    col: Math.floor(x / GameConfig.fogTileSize),
    row: Math.floor(y / GameConfig.fogTileSize),
  };
}

function getSightRange(entity, def) {
  // Дефолт на случай, если у типа юнита/здания не проставлен sightRange
  // явно (например, кто-то добавит новый тип и забудет про фог).
  return (def && def.sightRange) || 120;
}

// ИИ №9: возвращает Set ключей "col,row" всех fog-клеток сетки, которые
// физически занимает здание (с учётом его реального размера w/h из
// BuildingDefs, в тайлах tileSize, переведённого в клетки fogTileSize) —
// используется и как источник блокираторов (buildFogBlockerGrid), и как
// "свой footprint" при вызове revealWithRaycast для этого же здания (см.
// recomputeFogOfWar) — здание не должно слепить себя собственными стенами.
function getBuildingFootprintKeys(b) {
  const keys = new Set();
  const def = BuildingDefs[b.type];
  if (!def) return keys;
  const fts = GameConfig.fogTileSize;
  const wPx = def.w * GameConfig.tileSize;
  const hPx = def.h * GameConfig.tileSize;
  const left = b.x - wPx / 2, right = b.x + wPx / 2;
  const top = b.y - hPx / 2, bottom = b.y + hPx / 2;
  const colStart = Math.floor(left / fts), colEnd = Math.floor((right - 0.001) / fts);
  const rowStart = Math.floor(top / fts), rowEnd = Math.floor((bottom - 0.001) / fts);
  for (let col = colStart; col <= colEnd; col++) {
    for (let row = rowStart; row <= rowEnd; row++) {
      keys.add(fogKey(col, row));
    }
  }
  return keys;
}

// Строит Set ключей "col,row" клеток fog-сетки, занятых ЛЮБЫМ зданием на
// карте (свои+вражеские+remote-тени — здание физическое препятствие для
// обзора независимо от владельца, тот же принцип, что уже применяется в
// патфайндинге для движения). Пересобирается заново каждый вызов
// recomputeFogOfWar — зданий на карте немного (десятки, не тысячи), а
// перестраивать сетку только при постройке/разрушении было бы
// преждевременной оптимизацией для прототипа такого размера.
function buildFogBlockerGrid() {
  const blocked = new Set();

  function markBuilding(b) {
    getBuildingFootprintKeys(b).forEach(key => blocked.add(key));
  }

  Object.values(State.buildings).forEach(markBuilding);
  // Remote-тени зданий других игроков (Firebase MVP-сеть) — тоже реальные
  // препятствия на карте, как и в патфайндинге.
  if (State.remoteGhosts) {
    Object.values(State.remoteGhosts).forEach(pdata => {
      if (!pdata || !pdata.buildings) return;
      Object.values(pdata.buildings).forEach(markBuilding);
    });
  }

  return blocked;
}

// ИИ №9: простой raycasting по кругу от источника обзора. Пускаем лучи с
// равномерным угловым шагом, каждый луч идёт наружу с мелким шагом (пол-
// клетки fog-сетки) и раскрывает клетки до первого препятствия
// включительно, останавливаясь на нём (клетка ЗА стеной не раскрывается,
// сама стена — раскрывается, чтобы игрок видел контур того, что его
// блокирует, как в большинстве RTS). Источник обзора всегда видит
// собственную клетку и не блокируется зданием, из которого сам смотрит
// (иначе юниты внутри/у стен собственных построек были бы слепы) — для
// этого стартовая клетка центра исключена из проверки препятствий.
//
// Выбран простой raycasting, а не honest recursive shadowcasting: тот
// точнее в углах, но заметно сложнее реализовать и покрыть тестами, а
// грубая круговая модель с блокировкой по первому препятствию — это
// именно то поведение ("обойди, а не стой в радиусе"), которое было
// нужно по задаче, и она ближе к тому, как считали обзор классические
// RTS вроде C&C/Generals (упрощённая line-of-sight, а не честные тени).
// ownFootprintKeys (опционально) — Set ключей клеток, которые физически
// принадлежат САМОМУ источнику обзора (актуально для зданий крупнее 1x1:
// весь штаб 3x3 не должен слепить сам себя, а не только его центральная
// клетка) — эти клетки прозрачны для лучей ИЗ этого источника, даже если
// они присутствуют в общей blockedGrid (там они помечены, т.к. являются
// препятствием для ДРУГИХ источников обзора).
function revealWithRaycast(x, y, sightRange, blockedGrid, visible, ownFootprintKeys) {
  const fts = GameConfig.fogTileSize;
  const startCell = worldToFogCell(x, y);
  const startKey = fogKey(startCell.col, startCell.row);

  // Собственная клетка всегда видна и всегда разведана, независимо от
  // препятствий (юнит стоящий вплотную к стене не должен быть слеп).
  visible.add(startKey);
  State.fog.explored.add(startKey);

  const stepLen = fts / 2;
  const steps = Math.ceil(sightRange / stepLen);
  // Число лучей растёт вместе с радиусом обзора (иначе на большом
  // sightRange между соседними лучами появлялись бы "полосы" непроверенных
  // клеток), но с потолком — карта в прототипе небольшая, лишняя точность
  // сверх этого предела на глаз не заметна, а дороже считать каждый тик.
  const circumferenceCells = Math.ceil((2 * Math.PI * sightRange) / fts);
  const rayCount = Math.min(96, Math.max(16, circumferenceCells));

  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2;
    const dx = Math.cos(angle), dy = Math.sin(angle);

    for (let s = 1; s <= steps; s++) {
      const px = x + dx * s * stepLen;
      const py = y + dy * s * stepLen;
      if (dist(x, y, px, py) > sightRange) break;

      const cell = worldToFogCell(px, py);
      const key = fogKey(cell.col, cell.row);

      visible.add(key);
      State.fog.explored.add(key);

      // Луч гаснет НА первом препятствии (клетка препятствия видна — виден
      // силуэт того, что блокирует обзор, — но всё, что дальше по этому
      // лучу, уже нет). Собственные клетки источника (например, все 9
      // клеток штаба 3x3, не только его центр) никогда не считаются
      // препятствием для лучей ИЗ этого же источника.
      const isOwnFootprint = ownFootprintKeys && ownFootprintKeys.has(key);
      if (!isOwnFootprint && blockedGrid.has(key)) break;
    }
  }
}

// Пересчитывает fog.visible с нуля и пополняет fog.explored.
// Вызывается раз в тик из gameTick — сетка мелкая, а карта в прототипе
// небольшая, так что полный пересчёт каждый тик остаётся дешёвым; если
// карта вырастет на порядок или юнитов станет на порядок больше, стоит
// перейти на инкрементальное обновление (пересчитывать только вокруг
// сдвинувшихся юнитов) и/или закэшировать blockedGrid между тиками.
function recomputeFogOfWar() {
  if (!GameConfig.fogEnabled) return;

  const visible = new Set();
  const blockedGrid = buildFogBlockerGrid();

  Object.values(State.units).forEach(u => {
    if (u.ownerId !== localPlayerId) return;
    // Юниты — точечные источники (не многоклеточные), свой footprint не нужен.
    revealWithRaycast(u.x, u.y, getSightRange(u, UnitDefs[u.type]), blockedGrid, visible, null);
  });
  Object.values(State.buildings).forEach(b => {
    if (b.ownerId !== localPlayerId) return;
    // Здание может занимать несколько fog-клеток (например, штаб 3x3) —
    // все они должны быть прозрачны для обзора ИЗ этого же здания, иначе
    // здание слепит само себя изнутри собственных стен.
    const ownFootprint = getBuildingFootprintKeys(b);
    revealWithRaycast(b.x, b.y, getSightRange(b, BuildingDefs[b.type]), blockedGrid, visible, ownFootprint);
  });

  State.fog.visible = visible;

  // Обновляем "снимки" вражеских зданий: всё вражеское здание, что сейчас
  // видимо, кладём/обновляем в buildingGhosts; здания, что были в ghosts,
  // но их владелец уничтожен и клетка сейчас видима (значит место точно
  // пустое) — убираем.
  Object.values(State.buildings).forEach(b => {
    if (b.ownerId === localPlayerId) return;
    const cell = worldToFogCell(b.x, b.y);
    if (visible.has(fogKey(cell.col, cell.row))) {
      State.fog.buildingGhosts[b.id] = { type: b.type, x: b.x, y: b.y, ownerId: b.ownerId };
    }
  });
  Object.keys(State.fog.buildingGhosts).forEach(id => {
    const ghost = State.fog.buildingGhosts[id];
    const stillExists = State.buildings[id];
    if (stillExists) return; // здание живо — снимок обновится веткой выше при следующем разе
    const cell = worldToFogCell(ghost.x, ghost.y);
    if (visible.has(fogKey(cell.col, cell.row))) {
      // клетка сейчас видима, а здания там больше нет (снесли) — снимок устарел
      delete State.fog.buildingGhosts[id];
    }
  });
}

function isWorldPointVisible(x, y) {
  if (!GameConfig.fogEnabled) return true;
  const cell = worldToFogCell(x, y);
  return State.fog.visible.has(fogKey(cell.col, cell.row));
}

function isWorldPointExplored(x, y) {
  if (!GameConfig.fogEnabled) return true;
  const cell = worldToFogCell(x, y);
  return State.fog.explored.has(fogKey(cell.col, cell.row));
}

// ПРОМПТ для след. ИИ: raycasting здесь намеренно грубый (лучи по кругу,
// гасятся на первом препятствии), не honest recursive shadowcasting —
// возможные артефакты: при определённых углах луч может "проскочить"
// впритык мимо угла здания через щель уже клетки блокиратора (типичная
// проблема raycasting-фога, не уникальная для этого кода), и на очень
// больших sightRange у самых дальних колец возможны редкие пропуски
// клеток между соседними лучами, если rayCount упёрся в потолок 96, а не
// в реальную длину окружности. Если понадобится честная точность —
// стоит перейти на recursive shadowcasting по восьмушкам сетки.
