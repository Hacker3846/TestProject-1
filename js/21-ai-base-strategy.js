/* ---------------------------- ИИ №36: зональная застройка базы + масштабируемая оборона ---------------------------- */
// Прямой запрос пользователя: "улучши ии врага, сделай чтобы у него была
// стратегия, чтобы строил базы корректно а не как попало... сделай из него
// сверх разум типо". Задача разделена на 2 сессии по явной договорённости с
// пользователем (токен-бюджет) — эта сессия (ИИ №36) закрывает ТОЛЬКО
// "строит базы корректно, не как попало". Тактическая часть "атаковал когда
// надо" сверх уже существующего FSM/pressure-дожимания (ИИ №25/27) — ОТКРЫТО,
// см. запись в конце PROMPT_FOR_NEXT_AI_SHORT.md, оставлено следующему ИИ.
//
// Что было раньше (06-enemy-ai.js, дополнительно ужато 19-...js): здание
// ставится по чисто случайному углу на расширяющихся кольцах вокруг штаба —
// ЛЮБОЕ здание (казарма, электростанция, турель) с одинаковой вероятностью
// могло оказаться и прямо на пути игрока, и в тылу. Визуально база ИИ не
// выглядит "спланированной" — нет ощущения фронта/тыла.
//
// Что делает этот файл (2 независимых патча, оба — "переопределение после
// объявления", тот же приём, что весь проект, 13b-20):
//  1) enemyPlaceBuilding — здания теперь ставятся в ЗОНЫ относительно
//     направления "штаб ИИ -> ближайшее здание игрока" (frontAngle):
//       - economy (refinery/powerPlant) — сектор В ТЫЛУ (180° от фронта),
//         самое близкое кольцо к штабу — экономика должна быть максимально
//         защищена другими постройками/турелями, а не торчать первой на
//         пути атаки.
//       - production (barracks/warFactory/airfield) — два фланговых
//         сектора (~±115° от фронта) — не на самой линии огня, но и не
//         спрятаны в упор за спиной.
//       - defense (turret) — сектор НАПРЯМУЮ по фронту, кольцо ВЫНЕСЕНО
//         дальше остальных зон — турели встают как передовая линия между
//         экономикой ИИ и игроком, а не в произвольном месте базы.
//     Если в предпочитаемой зоне не нашлось места (тесно/задет край карты)
//     — фолбэк на полный круг вокруг штаба (старое поведение 19-...js), а
//     не бесконечное ожидание — постройка всё равно появится, просто не
//     обязательно в идеальном секторе.
//  2) enemyEconomyStep — скопирована ЦЕЛИКОМ из 06-enemy-ai.js (функция не
//     параметризована по числу турелей, точечно не патчится, тот же довод,
//     что уже использовал 19-...js для enemyPlaceBuilding) с ЕДИНСТВЕННЫМ
//     смысловым изменением: раньше ИИ строил РОВНО ОДНУ турель за всю
//     партию ("!enemyBuildings().some(type==='turret')"), теперь цель растёт
//     вместе с размером базы (enemyTurretTarget(), тот же принцип, что уже
//     есть у стен — enemyWallTarget, 18-walls.js), с потолком.
//
// Сознательно НЕ трогал: 18-walls.js (периметр стен вокруг bounding box
// построек по-прежнему работает как есть, зональная застройка просто меняет
// САМ bounding box — периметру всё равно, откуда он взялся), enemyBuildupStep/
// enemyAttackStep/enemyDefendBaseStep (06), findNearestEnemyInRange/
// attackerCandidateIds (19) — тактика боя и приоритет целей эта сессия не
// касается, только план застройки.
// Подключать ПОСЛЕДНИМ в game.html, после 20-corner-spawn.js.

/* ==================================================================
   ЧАСТЬ 1: зональная застройка
   ================================================================== */

// Какой зоне принадлежит здание. wall сюда намеренно не входит — стены
// ставит отдельная enemyWallStepClustered (19-...js), никогда не через
// enemyPlaceBuilding. commandCenter тоже не через эту функцию (создаётся
// напрямую в initEnemyStub). Неизвестный/будущий ключ без записи здесь —
// null-зона, см. sampleZoneAngle/findZoneBuildSpot ниже (фолбэк на полный
// круг, старое поведение, ничего не ломает при добавлении нового здания).
const AI_BUILD_ZONES = {
  powerPlant: "economy",
  refinery: "economy",
  barracks: "production",
  warFactory: "production",
  airfield: "production",
  turret: "defense",
};

// Секторы (в градусах, смещение от frontAngle) для каждой зоны. Секторы
// намеренно немного перекрываются/оставляют небольшие зазоры между собой —
// это не строгий раздел круга на непересекающиеся куски, а мягкое
// смещение вероятности в нужную сторону; лёгкое перекрытие не создаёт
// коллизий (isEnemyBuildPlacementValid всё равно проверяет геометрию).
const AI_ZONE_ARCS = {
  defense: [{ center: 0, spread: 55 }],               // прямо по фронту
  economy: [{ center: 180, spread: 60 }],              // прямо в тылу
  production: [{ center: 115, spread: 45 }, { center: -115, spread: 45 }], // оба фланга
};

// Кольца поиска места (px от штаба) — свои на каждую зону. defense вынесен
// заметно дальше остальных (передовая линия), economy — самое близкое
// кольцо (максимально защищено), production — между ними. default — фолбэк
// для null-зоны (новый/неизвестный ключ ИЛИ зональный поиск не нашёл места),
// те же числа, что уже были в 19-ai-target-priority-and-clustering.js
// (90..520, шаг 55) — сохраняем прежнюю плотность застройки как аварийный
// путь.
const AI_ZONE_RINGS = {
  defense:    { start: 200, step: 55, max: 560 },
  production: { start: 90,  step: 55, max: 480 },
  economy:    { start: 70,  step: 45, max: 380 },
  default:    { start: 90,  step: 55, max: 520 },
};

// Не даём зданиям ИИ вылезать за карту. Актуально стало именно сейчас
// (ИИ №36), а не раньше: раньше (18/19-...js) угол выбирался равномерно по
// всему кругу, поэтому смещение к краю карты было маловероятным случайным
// событием у любого конкретного здания. Теперь economy-зона (тыл) — это
// ВСЕГДА один и тот же узкий сектор, и если штаб ИИ заспавнился в углу
// карты (ИИ №35, 20-corner-spawn.js — старты по 4 углам), "тыл" очень часто
// будет указывать ровно в сторону ближайшего края карты — без клампа риск
// вылезти за границу стал бы систематическим, а не редким. Само по себе
// отсутствие проверки границ карты в isEnemyBuildPlacementValid — вопрос,
// существовавший и до этой сессии (см. её комментарий в 06-enemy-ai.js), не
// трогаю саму эту функцию, просто подрезаю кандидатскую точку ДО передачи
// в неё же.
const AI_MAP_EDGE_MARGIN = 64;
function clampToMapBounds(x, y) {
  const maxX = GameConfig.mapTilesW * GameConfig.tileSize - AI_MAP_EDGE_MARGIN;
  const maxY = GameConfig.mapTilesH * GameConfig.tileSize - AI_MAP_EDGE_MARGIN;
  return {
    x: Math.min(Math.max(x, AI_MAP_EDGE_MARGIN), maxX),
    y: Math.min(Math.max(y, AI_MAP_EDGE_MARGIN), maxY),
  };
}

// Направление "штаб ИИ -> игрок". ИИ не подчиняется фогу войны для
// собственных тактических/строительных решений — тот же принцип, что уже
// закреплён и прокомментирован в 06-enemy-ai.js (см. комментарий у
// playerCombatUnits/forcePressureRatio) и не оспаривается этой сессией,
// просто применяется ещё в одном месте. Фолбэк на центр карты — на случай
// (в норме недостижимый, штаб игрока существует с самого начала партии),
// если у игрока почему-то вообще нет построек в момент вызова.
function enemyFrontAngle(hq) {
  const playerBuildings = Object.values(State.buildings).filter(b => b.ownerId === localPlayerId && b.hp > 0);
  const target = playerBuildings.find(b => b.type === "commandCenter") || playerBuildings[0] || {
    x: GameConfig.mapTilesW * GameConfig.tileSize / 2,
    y: GameConfig.mapTilesH * GameConfig.tileSize / 2,
  };
  return Math.atan2(target.y - hq.y, target.x - hq.x);
}

// Случайный угол в пределах одного из секторов зоны (сектор выбирается
// случайно на КАЖДУЮ попытку — т.е. у production каждая новая попытка может
// упасть на любой из двух флангов, не только на один и тот же за весь
// вызов). zone===null (неизвестный ключ или явный фолбэк-проход) — старое
// поведение, равномерно по всему кругу.
function sampleZoneAngle(zone, frontAngle) {
  const arcs = zone && AI_ZONE_ARCS[zone];
  if (!arcs || arcs.length === 0) return Math.random() * Math.PI * 2;
  const arc = arcs[Math.floor(Math.random() * arcs.length)];
  const spreadRad = arc.spread * Math.PI / 180;
  const centerRad = frontAngle + arc.center * Math.PI / 180;
  return centerRad + (Math.random() * 2 - 1) * spreadRad;
}

// Тот же алгоритм расширяющихся колец, что и в 06/19 (попытки на кольцо —
// ENEMY_PLACEMENT_RING_ATTEMPTS, уже объявлена в 06-enemy-ai.js, не
// дублирую), только угол теперь берётся из sampleZoneAngle вместо чистого
// Math.random()*2π, и добавлен clampToMapBounds ДО снапа на сетку.
// Возвращает {x,y} на тайловой сетке или null, если во всех кольцах зоны
// места не нашлось (вызывающая сторона сама решает, фолбэчить ли на
// null-зону).
function findZoneBuildSpot(key, hq, zone, frontAngle) {
  const ringCfg = (zone && AI_ZONE_RINGS[zone]) || AI_ZONE_RINGS.default;
  for (let ringRadius = ringCfg.start; ringRadius <= ringCfg.max; ringRadius += ringCfg.step) {
    for (let attempt = 0; attempt < ENEMY_PLACEMENT_RING_ATTEMPTS; attempt++) {
      const angle = sampleZoneAngle(zone, frontAngle);
      const radius = ringRadius + Math.random() * (ringCfg.step * 0.8);
      const raw = { x: hq.x + Math.cos(angle) * radius, y: hq.y + Math.sin(angle) * radius };
      const clamped = clampToMapBounds(raw.x, raw.y);
      const snapped = (key !== "wall" && typeof snapBuildingCenterToGrid === "function")
        ? snapBuildingCenterToGrid(key, clamped.x, clamped.y) : clamped;
      if (isEnemyBuildPlacementValid(key, snapped.x, snapped.y)) return snapped;
    }
  }
  return null;
}

(function patchEnemyPlaceBuildingForZones() {
  if (typeof enemyPlaceBuilding !== "function") return;
  if (typeof isEnemyBuildPlacementValid !== "function" || typeof enemyHq !== "function") return;

  enemyPlaceBuilding = function (key) {
    const def = BuildingDefs[key];
    const player = State.players[enemyPlayerId];
    const hq = enemyHq();
    if (!hq || !def || player.credits < def.cost) return;

    const zone = AI_BUILD_ZONES[key] || null;
    const frontAngle = enemyFrontAngle(hq);

    let spot = zone ? findZoneBuildSpot(key, hq, zone, frontAngle) : null;
    if (!spot) {
      // Зоны нет ИЛИ предпочитаемая зона переполнена/упёрлась в край карты —
      // не блокируем стройку навсегда, ищем где угодно вокруг штаба тем же
      // алгоритмом (полный круг) — тот же принцип "не стой на месте", что
      // уже был в 19-...js.
      spot = findZoneBuildSpot(key, hq, null, frontAngle);
    }
    if (!spot) return; // совсем не нашли места (база забита до предела) — ждём следующего decision-тика, кредиты не тратим

    player.credits -= def.cost;
    const id = uid("b");
    // Точка сбора (rally) для производящих зданий (казармы/завод техники/
    // аэродром) смещена НЕ по фиксированной диагонали "вниз-вправо" (было
    // bx+30/by+30 — не зависело от направления к игроку вообще), а немного
    // В СТОРОНУ ФРОНТА — новые юниты рождаются уже развёрнутыми к
    // противнику. Для остальных зданий rally по смыслу не важен (turret/
    // refinery/powerPlant ничего не производят, buildQueue у них не
    // используется) — там оставлено старое поведение.
    const isProduction = zone === "production";
    const rally = isProduction
      ? { x: spot.x + Math.cos(frontAngle) * 55, y: spot.y + Math.sin(frontAngle) * 55 }
      : { x: spot.x + 30, y: spot.y + 30 };
    State.buildings[id] = {
      id, ownerId: enemyPlayerId, type: key,
      x: spot.x, y: spot.y, hp: def.hp, maxHp: def.hp,
      rallyX: rally.x, rallyY: rally.y, buildQueue: [],
    };
    logMsg(`Противник построил: ${def.label}`, "enemy");
  };
})();

/* ==================================================================
   ЧАСТЬ 2: масштабируемое число турелей
   ================================================================== */
const ENEMY_TURRET_TARGET_CAP = 5;
function enemyTurretTarget() {
  const substantial = enemyBuildings().filter(b => b.type !== "wall" && b.type !== "turret").length;
  return Math.min(ENEMY_TURRET_TARGET_CAP, Math.max(1, Math.ceil(substantial / 2)));
}

(function patchEnemyEconomyStepForTurretScaling() {
  if (typeof enemyEconomyStep !== "function") return;

  // Копия enemyEconomyStep из 06-enemy-ai.js 1:1, кроме блока турели (см.
  // пометку "ИИ №36" внутри) — функция не параметризована по числу турелей,
  // точечно не патчится (тот же довод, что уже использовал 19-...js для
  // enemyPlaceBuilding), поэтому полная копия, а не обёртка.
  enemyEconomyStep = function () {
    const player = State.players[enemyPlayerId];
    const hq = enemyHq();
    if (!hq) return;

    const refineryCount = enemyBuildings().filter(b => b.type === "refinery").length;
    const hasBarracks = enemyBuildings().some(b => b.type === "barracks");
    const hasPowerPlant = enemyBuildings().some(b => b.type === "powerPlant");

    if (!hasPowerPlant && player.credits >= BuildingDefs.powerPlant.cost) {
      enemyPlaceBuilding("powerPlant");
      return;
    }
    if (!hasBarracks && player.credits >= BuildingDefs.barracks.cost) {
      enemyPlaceBuilding("barracks");
      return;
    }
    if (refineryCount < ENEMY_REFINERY_TARGET() && player.credits >= BuildingDefs.refinery.cost) {
      enemyPlaceBuilding("refinery");
      return;
    }
    const hasWarFactory = enemyBuildings().some(b => b.type === "warFactory");
    if (hasBarracks && !hasWarFactory && player.credits >= BuildingDefs.warFactory.cost) {
      enemyPlaceBuilding("warFactory");
      return;
    }
    const hasAirfield = enemyBuildings().some(b => b.type === "airfield");
    if (hasWarFactory && !hasAirfield && player.credits >= BuildingDefs.airfield.cost) {
      enemyPlaceBuilding("airfield");
      return;
    }
    const comp = enemyComposition();
    const turretBlockedByTechPreference = comp.preferTechOverInfantry && !hasWarFactory;
    // ИИ №36: ЕДИНСТВЕННАЯ смысловая правка в этой копии — было
    // "!enemyBuildings().some(b => b.type === 'turret')" (максимум 1 турель
    // за всю партию, не масштабировалось с размером базы), теперь сравнение
    // со scaled-целью enemyTurretTarget() (см. выше, растёт с числом
    // построек базы, потолок ENEMY_TURRET_TARGET_CAP=5).
    const turretCount = enemyBuildings().filter(b => b.type === "turret").length;
    if (hasBarracks && !turretBlockedByTechPreference &&
        turretCount < enemyTurretTarget() &&
        player.credits >= BuildingDefs.turret.cost) {
      enemyPlaceBuilding("turret");
      return;
    }
    // Приоритет 5 (армия) — не здесь, см. enemyBuildupStep (06-enemy-ai.js,
    // не тронута этой сессией).
  };
})();

/* ---------------------------- ОТКРЫТО / НЕ СДЕЛАНО (следующему ИИ) ----------------------------
   См. запись "ИИ №36" в конце PROMPT_FOR_NEXT_AI_SHORT.md — там же
   отдельный промпт для второй сессии (тактическая часть: разведка состава
   игрока через фог, контр-состав армии, харассмент во время BUILDUP,
   приоритет целей "экономика игрока первой", многонаправленные атаки).
   Эта сессия задачу застройки базы закрыла, тактику атаки — нет, кроме уже
   существовавшего до неё FSM/pressure-дожимания (ИИ №25/27) и приоритета
   "бей стреляющего" (ИИ №35, 19-...js) — оба не тронуты. */
