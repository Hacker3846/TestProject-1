/* ---------------------------- ИИ №35: приоритет цели "бей стреляющего" + кучкование построек/стен ---------------------------- */
// Прямой запрос пользователя (2 независимые, но связанные правки):
//  1) "первее атаковал тех, кто в него стреляет, т.е атакующие здания и юниты" —
//     и юниты, и здания-цели (в т.ч. вражеского ИИ, но фикс общий — работает
//     симметрично и для игрока, т.к. findNearestEnemyInRange/updateDefensiveStructures
//     общие функции без привязки к ownerId) должны при выборе НОВОЙ цели
//     отдавать приоритет тому, кто СЕЙЧАС атакует именно их, а не слепо
//     ближайшему врагу.
//  2) "кучковал здания а потом окружал их стеной (не по одному зданию, а
//     сразу все)" — сейчас enemyPlaceBuilding (06-enemy-ai.js) раскидывает
//     постройки по случайным точкам расширяющихся колец (140-700px), а
//     enemyWallStep (18-walls.js) строит ПО ОДНОЙ стене за decision-тик на
//     фиксированном кольце 260-330px вокруг штаба — это не настоящий
//     периметр вокруг фактической застройки, а отдельное декоративное
//     кольцо, слабо связанное с тем, где здания реально стоят. Нужно:
//     здания ставить теснее друг к другу (компактный кластер), а стены
//     строить как честный прямоугольный периметр вокруг bounding box
//     реальных построек, укладывая СРАЗУ несколько стен за один
//     decision-тик, а не одну.
//
// Оба патча — "переопределение после объявления", как и весь проект
// (13b/14/15/16/17/18). Подключать ПОСЛЕДНИМ в game.html, после 18-walls.js
// (см. правило проекта: новый патч-файл — в конец цепочки, если не оговорено
// иное).

/* ==================================================================
   ЧАСТЬ 1: приоритет цели — "бей того, кто в тебя стреляет"
   ================================================================== */
// Идея: у каждого атакующего юнита/здания уже есть attackTargetId — это и
// есть "кто в кого стреляет" на этот момент, никакой новой книги учёта не
// нужно (не дублируем State новыми полями/картами — читаем уже существующее
// поле у всех живых юнитов/зданий). attackersOf(id) — какие юниты/здания
// СЕЙЧАС держат данный id как attackTargetId (т.е. атакуют его).
//
// findNearestEnemyInRange патчится ОДИН РАЗ здесь и обслуживает ОБЕ стороны
// (игрока и ИИ) симметрично — она общая функция, не завязана на
// enemyPlayerId. Так и приоритет "бей стреляющего" работает одинаково
// что для вражеского ИИ (просили в задаче — "враг должен приоритетно
// атаковать тех, кто в него стреляет"), что и для юнитов/турелей игрока
// заодно (не выделять частный случай — логика одна и та же в обе стороны,
// как и весь остальной боевой код проекта, см. isEnemyOf/findAttackableAt).
//
// Приоритет применяется ТОЛЬКО среди целей, которые и так уже в радиусе
// range (не расширяем радиус обнаружения ради атакующих — юнит не начинает
// видеть дальше своего штатного радиуса только потому что кто-то далёкий
// в него стреляет, это было бы уже другой механикой типа "инстинкт
// самосохранения через полкарты"). Среди целей В РАДИУСЕ: если хотя бы одна
// уже атакует нас (нашли в attackerCandidateIds) — выбираем БЛИЖАЙШУЮ ИЗ
// НИХ, а не глобально ближайшую цель. Если атакующих в радиусе нет —
// поведение не меняется вообще (старый путь "просто ближайший враг").
//
// ИИ №40: НЕ дёргает уже выбранную цель между несколькими атакующими — эта
// функция вообще не вызывается, пока у юнита уже есть живой attackTargetId
// в радиусе (см. updateCombat/updateDefensiveStructures, 07-game-loop-combat.js:
// там findNearestEnemyInRange вызывается ТОЛЬКО когда target ещё не задан
// или потерян). Значит если юнита одновременно бьют двое — он один раз
// выбирает ближайшего атакующего и держит именно его, пока тот жив и в
// радиусе, даже если появится другой атакующий чуть ближе. Патч ниже влияет
// только на МОМЕНТ выбора НОВОЙ цели, не на переключение уже выбранной —
// специально ничего менять здесь не нужно, инвариант обеспечивает 07-й файл.
function attackerCandidateIds(selfId) {
  const ids = new Set();
  Object.values(State.units).forEach(u => {
    if (u.hp > 0 && u.attackTargetId === selfId) ids.add(u.id);
  });
  Object.values(State.buildings).forEach(b => {
    if (b.hp > 0 && b.attackTargetId === selfId) ids.add(b.id);
  });
  return ids;
}

(function patchFindNearestEnemyInRangeForAttackerPriority() {
  if (typeof findNearestEnemyInRange !== "function") return;
  const _findNearestEnemyInRange = findNearestEnemyInRange;
  findNearestEnemyInRange = function (u, range) {
    // Сперва честно собираем ВСЕХ врагов в радиусе (юниты+здания), как
    // делал бы оригинал — но не выходим сразу с первой находкой, а
    // запоминаем и глобально ближайшего (фолбэк, поведение "как было"),
    // и ближайшего СРЕДИ атакующих (новый приоритет). Не вызываем
    // _findNearestEnemyInRange повторно на другую цель — считаем сами за
    // один проход, чтобы не дублировать O(n) дважды на каждый тик.
    const attackers = attackerCandidateIds(u.id);
    if (attackers.size === 0) {
      // Никто нас не атакует — быстрый путь, поведение старой функции
      // бит-в-бит (не тратим лишний проход по attackers впустую).
      return _findNearestEnemyInRange(u, range);
    }

    let bestAny = null, bestAnyD = Infinity;
    let bestAttacker = null, bestAttackerD = Infinity;

    function consider(other) {
      if (other.hp <= 0) return;
      if (!isEnemyOf(u.ownerId, other.ownerId)) return;
      const d = dist(u.x, u.y, other.x, other.y);
      if (d > range) return;
      if (d < bestAnyD) { bestAny = other; bestAnyD = d; }
      if (attackers.has(other.id) && d < bestAttackerD) { bestAttacker = other; bestAttackerD = d; }
    }
    Object.values(State.units).forEach(consider);
    Object.values(State.buildings).forEach(consider);

    // Приоритет: ближайший из тех, кто нас атакует. Если таких в радиусе
    // не нашлось (attackers непустой, но конкретно эти объекты вне range
    // или уже мертвы) — обычный фолбэк на глобально ближайшего врага.
    return bestAttacker || bestAny;
  };
})();

// ИИ-специфика: помимо автопоиска цели (уже покрыт патчем выше — общая
// функция), у вражеского ИИ есть ОТДЕЛЬНЫЙ путь простановки целей —
// enemyDefendBaseStep (06-enemy-ai.js) находит invader через тот же
// findNearestEnemyInRange (уже патченный выше, приоритет автоматически
// действует и здесь без дополнительных правок) и enemyAttackStep (гонит
// армию к hq игрока по attack-move, автопоиск цели там тоже идёт через
// updateCombat -> findNearestEnemyInRange, тот же патч). Отдельного патча
// на 06-enemy-ai.js для этой части не требуется — оба места ИИ уже
// пользуются пропатченной функцией, дублировать нечего.

/* ==================================================================
   ЧАСТЬ 2: кучкование построек + периметр стеной вокруг ВСЕХ сразу
   ================================================================== */
// 2а) Компактность застройки: enemyPlaceBuilding (06-enemy-ai.js) ищет
// место расширяющимися кольцами 140..700px с шагом 90. Не переписываем
// саму функцию (риск сломать проверку коллизий/фолбэк на нехватку места,
// которая уже работает) — патчим ТОЛЬКО стартовый радиус кольца через
// сужение первого прохода: оборачиваем isEnemyBuildPlacementValid нельзя
// (она не знает про радиус), поэтому патчим саму enemyPlaceBuilding целиком,
// сохраняя её алгоритм 1:1, но с более плотным начальным кольцом (90..520
// вместо 140..700, шаг тоже уменьшен) — база визуально плотнее группируется
// вокруг штаба, что и нужно для дальнейшего "окружить одной стеной", вместо
// того чтобы здания расползались на весь ENEMY_PLACEMENT_MAX_RADIUS.
(function patchEnemyPlaceBuildingForClustering() {
  if (typeof enemyPlaceBuilding !== "function") return;
  if (typeof isEnemyBuildPlacementValid !== "function" || typeof enemyHq !== "function") return;

  const CLUSTER_RING_START = 90;   // было 140 — плотнее к штабу
  const CLUSTER_RING_STEP = 55;    // было 90 — мельче шаг, застройка плотнее ложится по кольцам
  const CLUSTER_RING_MAX = 520;    // было 700 — не даём базе расползаться слишком далеко

  enemyPlaceBuilding = function (key) {
    const def = BuildingDefs[key];
    const player = State.players[enemyPlayerId];
    const hq = enemyHq();
    if (!hq || !def || player.credits < def.cost) return;

    let bx = null, by = null;
    for (let ringRadius = CLUSTER_RING_START; ringRadius <= CLUSTER_RING_MAX; ringRadius += CLUSTER_RING_STEP) {
      for (let attempt = 0; attempt < ENEMY_PLACEMENT_RING_ATTEMPTS; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = ringRadius + Math.random() * (CLUSTER_RING_STEP * 0.8);
        // ИИ (по прямому запросу пользователя, "здания [любые] ставятся
        // строго в клетки") — снап на тайловую сетку ДО проверки валидности,
        // той же общей функцией, что и игрок (см. 02-utils-canvas.js). Это
        // ЕДИНСТВЕННЫЙ активный путь постройки обычных зданий ИИ (эта
        // функция переопределяет enemyPlaceBuilding из 06-enemy-ai.js целиком —
        // см. комментарий выше в этом файле), так что снап нужен именно тут,
        // а не только в оригинале 06.
        const raw = { x: hq.x + Math.cos(angle) * radius, y: hq.y + Math.sin(angle) * radius };
        const snapped = (key !== "wall" && typeof snapBuildingCenterToGrid === "function")
          ? snapBuildingCenterToGrid(key, raw.x, raw.y) : raw;
        const tx = snapped.x, ty = snapped.y;
        if (isEnemyBuildPlacementValid(key, tx, ty)) { bx = tx; by = ty; break; }
      }
      if (bx != null) break;
    }

    if (bx == null) return; // как в оригинале — не нашли места, ждём следующего decision-тика

    player.credits -= def.cost;
    const id = uid("b");
    State.buildings[id] = {
      id, ownerId: enemyPlayerId, type: key,
      x: bx, y: by, hp: def.hp, maxHp: def.hp,
      rallyX: bx + 30, rallyY: by + 30, buildQueue: [],
    };
    logMsg(`Противник построил: ${def.label}`, "enemy");
  };
})();

// 2б) Периметр стеной вокруг ФАКТИЧЕСКОЙ застройки, а не декоративное
// кольцо фиксированного радиуса. Заменяем enemyWallStep (18-walls.js)
// целиком (переопределение после объявления — тот же приём) на версию,
// которая:
//   1) считает bounding box всех небоевых+боевых построек ИИ, КРОМЕ уже
//      существующих стен (enemyBuildings().filter(type!=="wall")) —
//      именно это "кучка зданий", которую нужно окружить;
//   2) строит прямоугольный периметр стен вокруг этого bounding box с
//      отступом WALL_PERIMETER_MARGIN, расставляя точки с шагом
//      wallChainStepLength() (та же функция, что уже считает шаг цепочки
//      для игрока в 18-walls.js — переиспользуем, чтобы периметр ИИ
//      состоял из стен без швов/наложений, как и цепочка игрока);
//   3) СРАЗУ строит НЕСКОЛЬКО точек периметра за один decision-тик
//      (до ENEMY_WALL_BUILD_PER_TICK штук, по кредитам), а не одну — это
//      и есть "сразу все", а не по одному зданию за раз, как было.
// Кап ENEMY_WALL_TARGET_CAP/ENEMY_WALL_TARGET_PER_BUILDING (18-walls.js) —
// сохраняем как ограничитель ОБЩЕГО числа стен (не считаем периметр
// бесконечным ресурсом), но само РАЗМЕЩЕНИЕ теперь честный прямоугольник
// вокруг базы, а не случайное кольцо.
// ПРАВКА (по прямому запросу пользователя: "закрыл полностью базу стенами
// ...не оставляя зазора между заборами") — margin уменьшен (90 -> 55): при
// компактной базе (после сжатия колец в 21-ai-base-strategy.js) большой
// отступ раздувал периметр без пользы. ENEMY_WALL_BUILD_PER_TICK поднят
// заметно (4 -> 10): с честной целью по реальному периметру (см.
// enemyWallTarget, 18-walls.js) нужно закрыть куда больше сегментов, чем
// раньше — при старом значении 4 периметр мог достраиваться десятками
// decision-тиков, оставляя дыры открытыми всю игру; теперь база
// закрывается полностью за разумное число тиков после того, как
// появляются деньги.
const WALL_PERIMETER_MARGIN = 55; // px отступ периметра от крайних построек
const ENEMY_WALL_BUILD_PER_TICK = 10; // сколько стен максимум ставим за один decision-тик

function enemyBuildingsBoundingBox() {
  const buildings = enemyBuildings().filter(b => b.type !== "wall");
  if (buildings.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  buildings.forEach(b => {
    const bdef = BuildingDefs[b.type];
    const halfW = (bdef ? bdef.w : 1) * GameConfig.tileSize / 2;
    const halfH = (bdef ? bdef.h : 1) * GameConfig.tileSize / 2;
    minX = Math.min(minX, b.x - halfW);
    minY = Math.min(minY, b.y - halfH);
    maxX = Math.max(maxX, b.x + halfW);
    maxY = Math.max(maxY, b.y + halfH);
  });
  return { minX, minY, maxX, maxY };
}

// Точки периметра прямоугольника (расширенного на margin) с фиксированным
// шагом step по каждой стороне, по часовой стрелке, включая углы — тот же
// принцип "цепочки", что и у игрока (computeWallChainPoints, 18-walls.js),
// только по контуру прямоугольника, а не по прямой линии между двумя
// точками протяжки.
// БАГФИКС (по прямому запросу пользователя — "калитки" в стенах, та же
// причина, что в 18-walls.js): box.minX/minY зависят от произвольных
// координат построек ИИ (enemyBuildingsBoundingBox) и margin —x0/y0 почти
// никогда не попадают ровно на тайловую сетку карты. Раньше все точки
// периметра считались как x0 + i*step, наследуя это произвольное смещение
// от сетки на ВСЮ линию периметра — стены ИИ стояли на своей отдельной,
// сдвинутой от общей сетке (той же природы баг, что раньше был у
// snapWallPointToGrid для игрока), из-за чего периметр ИИ мог не
// стыковаться сам с собой в углах и с другими постройками ИИ. Теперь
// каждая точка периметра снапается на ту же единую тайловую сетку центров
// клеток, что и все остальные здания (snapBuildingCenterToGrid("wall", ...),
// 02-utils-canvas.js) ПОСЛЕ вычисления позиции по периметру — сдвигает её
// не больше чем на полклетки, форма прямоугольника визуально не меняется,
// но все стены оказываются на одной сетке без щелей.
function computeWallPerimeterPoints(box, margin, step) {
  const x0 = box.minX - margin, y0 = box.minY - margin;
  const x1 = box.maxX + margin, y1 = box.maxY + margin;
  const snap = (x, y) => (typeof snapBuildingCenterToGrid === "function")
    ? snapBuildingCenterToGrid("wall", x, y) : { x, y };
  const pts = [];
  const pushPoint = (x, y) => {
    const p = snap(x, y);
    // не дублируем точку, если она практически совпадает с последней добавленной
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < step * 0.5) return;
    pts.push(p);
  };

  // верхняя сторона: слева направо
  for (let x = x0; x <= x1; x += step) pushPoint(x, y0);
  pushPoint(x1, y0);
  // правая сторона: сверху вниз
  for (let y = y0; y <= y1; y += step) pushPoint(x1, y);
  pushPoint(x1, y1);
  // нижняя сторона: справа налево
  for (let x = x1; x >= x0; x -= step) pushPoint(x, y1);
  pushPoint(x0, y1);
  // левая сторона: снизу вверх
  for (let y = y1; y >= y0; y -= step) pushPoint(x0, y);
  pushPoint(x0, y0);

  return pts;
}

function wallStepLengthSafe() {
  // wallChainStepLength() определена в 18-walls.js (переиспользуем её же
  // формулу шага цепочки — периметр ИИ должен состоять из стен того же
  // шага, что и цепочка игрока, чтобы клетки визуально стыковались без
  // швов по тому же WALL_GAP_FILL_MAX-механизму, см. её комментарий).
  if (typeof wallChainStepLength === "function") return wallChainStepLength();
  return BuildingDefs.wall.w * GameConfig.tileSize; // фолбэк, если 18-walls.js почему-то не подключён
}

function enemyWallStepClustered() {
  const player = State.players[enemyPlayerId];
  const hq = enemyHq();
  if (!hq) return;

  const box = enemyBuildingsBoundingBox();
  if (!box) return; // ещё нет ни одного небоевого здания — окружать нечего

  const step = wallStepLengthSafe();
  const perimeterPoints = computeWallPerimeterPoints(box, WALL_PERIMETER_MARGIN, step);

  // БАГФИКС (найден при повторной проверке после правки на "не оставляя
  // зазора между заборами"): раньше здесь стоял ранний выход
  // "if (wallCount >= target) return" ДО вычисления bounding box/периметра.
  // Проблема — target это ПРОСТО ЧИСЛО точек текущего периметра, а не
  // гарантия, что именно ЭТИ точки уже закрыты стенами. Если периметр
  // СМЕСТИЛСЯ (например, здание разрушено с одной стороны базы и построено
  // новое с другой — bounding box сдвинулся, но количество точек périметра
  // осталось тем же), wallCount мог сравняться со старым target, хотя
  // новые точки периметра по факту голые — функция вышла бы, ничего не
  // построив, и дыра осталась бы навсегда (следующий тик видел бы ту же
  // ложную картину). Теперь mы всегда считаем geometry заново (дёшево) и
  // решаем что строить по факту непокрытых точек, а не по одному числу.
  const target = enemyWallTarget(); // тот же расчёт цели, что использует 18-walls.js — здесь только как потолок трат, см. ниже
  const wallCount = enemyBuildings().filter(b => b.type === "wall").length;

  let built = 0;
  for (const p of perimeterPoints) {
    if (built >= ENEMY_WALL_BUILD_PER_TICK) break;
    if (wallCount + built >= target) break; // не тратим кредиты сверх потолка цели/капа — но это НЕ мешает пройти весь периметр в поисках непокрытых точек, см. continue ниже
    if (player.credits < BuildingDefs.wall.cost) break;
    // уже стена именно в этой точке периметра (построена раньше) —
    // пропускаем без траты попытки и без учёта в built, это не "пропуск
    // дыры", а нормальный повторный проход по уже закрытому сегменту.
    const alreadyWall = enemyBuildings().some(b => b.type === "wall"
      && Math.hypot(b.x - p.x, b.y - p.y) < step * 0.5);
    if (alreadyWall) continue;
    if (!isEnemyBuildPlacementValid("wall", p.x, p.y)) continue; // место временно занято (юнит/чужое здание) — пропускаем именно эту точку, следующий decision-тик попробует её снова

    player.credits -= BuildingDefs.wall.cost;
    const id = uid("b");
    State.buildings[id] = {
      id, ownerId: enemyPlayerId, type: "wall",
      x: p.x, y: p.y, hp: BuildingDefs.wall.hp, maxHp: BuildingDefs.wall.hp,
      rallyX: p.x, rallyY: p.y, buildQueue: [],
    };
    built++;
  }

  if (built > 0) {
    logMsg(built > 1 ? `Противник возводит периметр стен (${built})` : "Противник укрепляет периметр стеной", "enemy");
  }
}

// Заменяем саму enemyWallStep (18-walls.js уже вызывает её из своего патча
// над updateEnemyStub каждый decision-тик — тот вызов сделан через голое
// имя функции `enemyWallStep()`, не через сохранённую ссылку, поэтому
// достаточно переприсвоить глобальную функцию здесь: следующий вызов из
// патча 18-walls.js увидит уже нашу версию). Не патчим updateEnemyStub
// заново (не плодим ещё один слой обёртки поверх и так уже обёрнутой
// 18-walls.js функции) — переопределение имени enemyWallStep дешевле и
// достаточно, порядок подключения (19 строго после 18) это гарантирует.
if (typeof enemyWallStep === "function") {
  enemyWallStep = enemyWallStepClustered;
}
