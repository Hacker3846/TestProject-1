/* ---------------------------- ИИ №48: экономика обороны ИИ привязана к причине ---------------------------- */
// Прямой запрос пользователя: "надо чтобы ИИ был умнее... он не умеет
// грамотно вложиться, защищать базу и тд, пусть не защищается без причины,
// а когда защищается пусть давит огнестрелами, а не трусит и ставит только
// стены". Задача разделена на 2 сессии по договорённости с пользователем
// (токен-бюджет) — эта сессия (ИИ №48) закрывает ТОЛЬКО экономическую
// половину: "не вкладывается с умом" + "защищается без причины". Тактическая
// половина ("давит огнестрелами, когда есть повод") — ОТКРЫТО, следующему
// ИИ, см. футер этого файла и отдельный промпт, переданный пользователем.
//
// ДИАГНОЗ (перед правкой, по факту чтения кода, не с потолка):
// enemyWallStepClustered (19-...js) строила до ENEMY_WALL_BUILD_PER_TICK
// стен ЗА ОДИН decision-тик, enemyTurretTarget (21-...js) растила турели
// до 22шт по формуле от числа построек, enemyMortarAndMineStep (25-...js)
// добавляла ещё до 3 мортир + 4 мин — и всё это СОВЕРШЕННО не зависело от
// того, есть ли у ИИ реальная причина укрепляться (атакован ли он, стоит
// ли враг у базы, объективно ли слабее игрок) — только от размера
// собственной базы. На практике потенциальная скорость траты на стены
// (до 400кр/тик) часто ПРЕВЫШАЛА весь доход ИИ в секунду, из-за чего любой
// накопленный излишек кредитов почти всегда утекал в стены/турели раньше,
// чем в армию — отсюда ощущение "владеет только стенами". Числовые потолки
// уже снижены точечно (см. правки в 18-walls.js/19-.../21-...js), этот файл
// добавляет ВТОРОЙ, более важный слой — рост обороны СВЕРХ скромного
// базового уровня теперь требует реальной причины.
//
// Архитектура (тот же приём "переопределение после объявления", что и весь
// проект, 13b-25) — НИЧЕГО не скопировано целиком без необходимости, только
// enemyMortarAndMineStep (её константы-лимиты читаются как обычные consts
// внутри тела функции, не через вызов функции-геттера, поэтому дешевле
// скопировать её тело с готовыми порогами, чем городить рефактор чужого
// файла ради двух чисел):
//  1) enemyThreatMemory + патчи killUnit/killBuilding — запоминаем момент
//     последней реальной потери ИИ (юнит/здание), это и есть объективный
//     сигнал "меня только что атаковали", без всякой эвристики.
//  2) enemyBaseUnderActiveThreat() — есть ли ПРЯМО СЕЙЧАС боевой юнит
//     игрока рядом с существенной (не-стеновой) постройкой ИИ.
//  3) enemyDefenseJustified() — объединяет (1)+(2)+уже существующий
//     "игрок объективно сильнее" (isOutmatched, та же формула, что в
//     updateEnemyStub/06-enemy-ai.js) в одно "да/нет, есть причина
//     защищаться сверх базового уровня".
//  4) enemyWallTarget/enemyTurretTarget обёрнуты: без причины — потолок
//     урезается до скромного базового уровня (периметр/оборона всё равно
//     есть, база не выглядит голой — по отзыву "не плохо" про сами стены),
//     с причиной — работает полный (уже сниженный точечно) потолок.
//  5) enemyWallStep (глобальное имя, сейчас указывает на
//     enemyWallStepClustered, см. 19-...js) обёрнут паузой на фазу ATTACK —
//     та же граница, что мортира/мина УЖЕ соблюдают (см. её же комментарий
//     в 25-...js: "экономика ИИ не работает во время атаки"), стены раньше
//     этой границы не знали и достраивались даже в разгар своей атаки.
//  6) enemyMortarAndMineStep переопределена целиком (см. обоснование выше)
//     с тем же баланс-принципом "1 мортира/2 мины без причины, полный
//     лимит — с причиной".
// Подключать ПОСЛЕДНИМ в game.html, после 25-mortar-and-mines.js.

/* ==================================================================
   ЧАСТЬ 1: "есть ли причина защищаться" — общая функция для этого файла
   и для следующей сессии (тактика). НЕ приватная — сознательно оставлена
   глобальной, чтобы enemyDefendBaseStep следующей сессии мог использовать
   тот же критерий "причины", а не изобретать второй, слегка другой.
   ================================================================== */

// Момент (в enemyMatchClock.elapsedMs, не Date.now() — тот же "внутриигровой"
// таймер, что уже использует вся остальная эскалация ИИ, см. 06-enemy-ai.js)
// последней потери ИИ. -Infinity — ИИ ещё ни разу не терял юнита/здание за
// эту партию, что честно означает "давно/никогда не атакован".
const enemyThreatMemory = { lastAttackedAtMs: -Infinity };

(function patchKillUnitForThreatMemory() {
  if (typeof killUnit !== "function") return;
  const _killUnitForThreat = killUnit;
  killUnit = function (id) {
    // Читаем ownerId ДО вызова оригинала — killUnit удаляет запись из
    // State.units, после вызова её уже не будет.
    const u = State.units[id];
    if (u && u.ownerId === enemyPlayerId) {
      enemyThreatMemory.lastAttackedAtMs = enemyMatchClock.elapsedMs;
    }
    return _killUnitForThreat(id);
  };
})();

(function patchKillBuildingForThreatMemory() {
  if (typeof killBuilding !== "function") return;
  const _killBuildingForThreat = killBuilding;
  killBuilding = function (id) {
    const b = State.buildings[id];
    if (b && b.ownerId === enemyPlayerId) {
      enemyThreatMemory.lastAttackedAtMs = enemyMatchClock.elapsedMs;
    }
    return _killBuildingForThreat(id);
  };
})();

// "Недавно атакован" — окно памяти в 20 игровых секунд. Достаточно долго,
// чтобы не забывать про угрозу между соседними decision-тиками, но не
// настолько долго, чтобы ИИ навсегда застрял в "параноидальном" режиме
// после одной случайной стычки в начале партии.
const ENEMY_THREAT_MEMORY_WINDOW_MS = 20000;
function enemyWasRecentlyAttacked() {
  return (enemyMatchClock.elapsedMs - enemyThreatMemory.lastAttackedAtMs) <= ENEMY_THREAT_MEMORY_WINDOW_MS;
}

// Есть ли ПРЯМО СЕЙЧАС боевой юнит игрока рядом с существенной постройкой
// ИИ. Специально ИСКЛЮЧАЕМ стены из проверяемых построек (enemyBuildings()
// .filter(type!=="wall")) — периметр стен окружает всю базу, юнит игрока,
// который просто идёт мимо внешнего края периметра, не должен считаться
// "угрозой", иначе почти любое перемещение армии игрока рядом с картой ИИ
// держало бы ИИ в вечном "оправданном" состоянии, что обесценило бы саму
// идею привязки к причине. ИИ намеренно не подчиняется фогу войны для
// собственных решений (тот же принцип, что уже закреплён в
// forcePressureRatio/enemyFrontAngle, 06/21-...js) — берём ВСЕ боевые юниты
// игрока, а не только разведанные.
const ENEMY_THREAT_PROXIMITY_RADIUS = 300;
function enemyBaseUnderActiveThreat() {
  const substantialBuildings = enemyBuildings().filter(b => b.type !== "wall");
  if (substantialBuildings.length === 0) return false;
  const invaders = playerCombatUnits();
  if (invaders.length === 0) return false;
  for (const b of substantialBuildings) {
    for (const inv of invaders) {
      if (dist(b.x, b.y, inv.x, inv.y) <= ENEMY_THREAT_PROXIMITY_RADIUS) return true;
    }
  }
  return false;
}

// Итоговый критерий "есть причина защищаться сверх базового уровня":
//  - враг СЕЙЧАС физически у базы, ИЛИ
//  - ИИ что-то потерял за последние ENEMY_THREAT_MEMORY_WINDOW_MS, ИЛИ
//  - армия игрока объективно намного сильнее армии ИИ (та же формула
//    isOutmatched, что уже применяется в updateEnemyStub, 06-enemy-ai.js —
//    переиспользуем forcePressureRatio/ENEMY_CAUTION_THRESHOLD как единый
//    источник истины про "игрок явно сильнее", а не второй похожий порог).
// Без ни одного из трёх — ИИ строит достаточно для приличия (базовый
// уровень ниже), но не тратит на оборону деньги, которые нужнее армии.
function enemyDefenseJustified() {
  if (enemyBaseUnderActiveThreat()) return true;
  if (enemyWasRecentlyAttacked()) return true;
  const pressure = forcePressureRatio();
  if (pressure > 0 && pressure <= (1 / ENEMY_CAUTION_THRESHOLD())) return true;
  return false;
}

/* ==================================================================
   ЧАСТЬ 2: стены — базовый уровень без причины, полный потолок с причиной
   ================================================================== */
// Базовый уровень ниже полного потолка (ENEMY_WALL_TARGET_CAP=40,
// 18-walls.js после правки этой же сессии) — периметр без причины всё
// равно частично закрывается (база не выглядит голой), просто не
// достраивается до предела, если враг ни разу не подходил и не был явно
// сильнее.
const ENEMY_WALL_BASELINE_CAP = 16;
(function patchEnemyWallTargetForThreatGating() {
  if (typeof enemyWallTarget !== "function") return;
  const _enemyWallTargetReal = enemyWallTarget;
  enemyWallTarget = function () {
    const real = _enemyWallTargetReal();
    if (enemyDefenseJustified()) return real;
    return Math.min(real, ENEMY_WALL_BASELINE_CAP);
  };
})();

// Пауза на фазу ATTACK — та же граница, что уже соблюдает мортира/мина
// (25-...js), но раньше НЕ применялась к стенам (enemyWallStep вызывалась
// каждый decision-тик независимо от фазы FSM, см. 18-walls.js). Пока
// собственная армия ИИ штурмует базу игрока, деньги логичнее оставить на
// сам штурм/восстановление экономики после него, а не тратить на периметр
// дома, который в этот момент никто не атакует (иначе враг был бы уже
// обнаружен enemyBaseUnderActiveThreat выше и enemyDefenseJustified и так
// разрешил бы полный потолок).
(function patchEnemyWallStepForAttackPause() {
  if (typeof enemyWallStep !== "function") return;
  const _enemyWallStepReal = enemyWallStep;
  enemyWallStep = function () {
    if (enemyFsm.phase === "ATTACK") return;
    return _enemyWallStepReal();
  };
})();

/* ==================================================================
   ЧАСТЬ 3: турели — тот же принцип базового/полного уровня
   ================================================================== */
const ENEMY_TURRET_BASELINE_CAP = 4;
(function patchEnemyTurretTargetForThreatGating() {
  if (typeof enemyTurretTarget !== "function") return;
  const _enemyTurretTargetReal = enemyTurretTarget;
  enemyTurretTarget = function () {
    const real = _enemyTurretTargetReal();
    if (enemyDefenseJustified()) return real;
    return Math.min(real, ENEMY_TURRET_BASELINE_CAP);
  };
})();
// Турели строятся через enemyEconomyStep (внутри ECONOMY/BUILDUP/REGROUP,
// см. 06/21-...js) — та же функция уже НЕ вызывается во время ATTACK
// (switch в updateEnemyStub зовёт только enemyAttackStep в этой фазе),
// так что отдельного патча "пауза на ATTACK" для турелей, в отличие от
// стен, не требуется — эта граница у них была соблюдена с самого начала.

/* ==================================================================
   ЧАСТЬ 4: мортира/мина — тот же принцип, целиком переопределённая копия
   (обоснование копирования целиком — см. шапку файла)
   ================================================================== */
(function patchEnemyMortarAndMineStepForThreatGating() {
  if (typeof enemyMortarAndMineStep !== "function") return;
  if (typeof MORTAR_LIMIT_PER_PLAYER === "undefined" || typeof ENEMY_MINE_TARGET === "undefined") return;

  const ENEMY_MORTAR_BASELINE_CAP = 1;
  const ENEMY_MINE_BASELINE_CAP = 2;

  enemyMortarAndMineStep = function () {
    if (enemyFsm.phase === "ATTACK") return; // та же граница, что и раньше (25-...js)
    const player = State.players[enemyPlayerId];
    if (!player) return;
    const hasBarracks = enemyBuildings().some(b => b.type === "barracks");
    const hasTurret = enemyBuildings().some(b => b.type === "turret");
    if (!hasBarracks || !hasTurret) return;

    const justified = enemyDefenseJustified();

    const mortarCap = justified ? MORTAR_LIMIT_PER_PLAYER : Math.min(MORTAR_LIMIT_PER_PLAYER, ENEMY_MORTAR_BASELINE_CAP);
    if (countOwnerMortars(enemyPlayerId) < mortarCap && player.credits >= BuildingDefs.mortar.cost) {
      enemyPlaceBuilding("mortar");
      return;
    }

    const mineCap = justified ? ENEMY_MINE_TARGET : Math.min(ENEMY_MINE_TARGET, ENEMY_MINE_BASELINE_CAP);
    const mineCount = enemyBuildings().filter(b => b.type === "landmine").length;
    if (mineCount < mineCap && player.credits >= BuildingDefs.landmine.cost) {
      enemyPlaceBuilding("landmine");
    }
  };
})();

/* ---------------------------- ОТКРЫТО / НЕ СДЕЛАНО (следующему ИИ) ----------------------------
   Эта сессия (ИИ №48) закрыла ТОЛЬКО экономическую сторону запроса: рост
   статичной обороны (стены/турели/мортиры/мины) теперь ограничен базовым
   уровнем, если нет реальной причины, и полностью реализуется, только
   когда причина есть (см. enemyDefenseJustified выше — используй ЕЁ, не
   изобретай вторую похожую проверку).

   НЕ СДЕЛАНО (тактическая часть, прямой запрос пользователя: "когда
   защищается пусть давит огнестрелами, а не трусит и ставит только
   стены"):
    - enemyDefendBaseStep (06-enemy-ai.js) реагирует только на юнитов,
      которые УЖЕ простаивают (idle) в 260px от ШТАБА конкретно — не
      отзывает армию с фронта (ATTACK-фаза) или из BUILDUP, если база
      реально атакована в этот момент, и не проверяет угрозу у прочих
      построек (только hq). enemyBaseUnderActiveThreat() (эта сессия,
      выше) уже умеет проверять угрозу у ВСЕХ существенных построек —
      переиспользуй её вместо велосипеда с проверкой только у hq.
    - Нет отзыва боевых юнитов из ATTACK/BUILDUP на защиту дома при
      реальной угрозе — сейчас, если база атакована ПОКА армия ИИ штурмует
      игрока, дом защищать физически некому, кроме турелей/мин.
    - "Давит огнестрелами, а не стенами" — при реальной угрозе оборона
      должна опираться в первую очередь на боевые юниты (пехота/техника),
      а не только на здания-турели; сейчас порядок эскалации ("сначала
      турель, потом мортира/мина", см. 06/25-...js) не связан с тем,
      сколько живой армии сейчас стоит дома.
   Использовать enemyThreatMemory/enemyBaseUnderActiveThreat/
   enemyDefenseJustified (эта сессия, выше в этом файле) как готовый
   строительный блок — не дублировать вторую версию "есть ли угроза". */
