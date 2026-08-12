/* ---------------------------- ИИ-противник: конечный автомат ---------------------------- */
// ИИ №4: раньше это была голая заглушка (existence + раз в 5с случайный
// юнит в сторону игрока, без экономики). Переписал на простой явный
// конечный автомат с 4 фазами (см. enemyFsm.phase): ECONOMY -> BUILDUP ->
// ATTACK -> REGROUP, по кругу. Это ЕЩЁ НЕ "настоящий" стратегический ИИ
// (нет разведки, нет реакции на состав сил игрока, нет обороны конкретных
// точек) — честно: это прежде всего "не стоит на месте и пополняет войска",
// но уже качественно другой уровень, чем было. Детали и упрощения — в
// футере файла.

const enemyPlayerId = "enemy_ai";

// ИИ №29: seedEnemyResourceNode() убрана вместе с узлами ресурсов/харвестом
// (юнит worker удалён, добыча теперь пассивна через здание refinery — см.
// updateRefineries, 07-game-loop-combat.js). Больше не вызывается из
// initEnemyStub() ниже.

function initEnemyStub() {
  // ИИ №8: цвет берём из выбранной игроком фракции (js/01-config-state.js,
  // EnemyFactionProfiles). Если выбор почему-то не сделан (SelectedEnemyProfile
  // отсутствует/битый) — старый хардкод-цвет "#8a2a1f" как надёжный фолбэк,
  // чтобы initEnemyStub() не падал даже при отсутствии экрана выбора.
  const factionKey = (typeof SelectedEnemyProfile !== "undefined" && SelectedEnemyProfile.faction) || "crimson";
  const faction = (typeof EnemyFactionProfiles !== "undefined" && EnemyFactionProfiles[factionKey]) || { color: "#8a2a1f" };
  State.players[enemyPlayerId] = {
    id: enemyPlayerId, credits: 1000, power: 0, powerUse: 0,
    color: faction.color, side: "enemy",
  };
  const hqId = uid("b");
  State.buildings[hqId] = {
    id: hqId, ownerId: enemyPlayerId, type: "commandCenter",
    x: 1500, y: 1000, hp: BuildingDefs.commandCenter.hp, maxHp: BuildingDefs.commandCenter.hp,
    rallyX: 1450, rallyY: 950, buildQueue: [],
  };

  // ПРАВКА (по прямому запросу пользователя: "пусть в начале не будет
  // построено здание добытчик, а сам штаб выполняет эту роль") — раньше
  // тут (ИИ №29) ставилась отдельная стартовая refinery рядом со штабом
  // ИИ, симметрично игроку. Теперь штаб САМ несёт incomePerTick (см.
  // BuildingDefs.commandCenter, 01-config-state.js) — держим симметрию с
  // 05-init-world.js: ИИ тоже стартует без отдельного здания-добытчика,
  // экономика штаба та же самая функция updateRefineries
  // (07-game-loop-combat.js), никакой отдельной ветки для ИИ не нужно.
  // enemyBuildupStep (см. ниже, приоритет "здания refinery") по-прежнему
  // умеет строить refinery ПОЗЖЕ как обычное здание — ENEMY_REFINERY_TARGET
  // считает refineryCount по факту стоящих зданий (сейчас 0 на старте),
  // так что ИИ достроит первую refinery сам в рамках обычной экономики,
  // ничего дополнительно патчить не нужно.

  // ИИ №4: стартовый rifleman (для ранней самообороны, пока казарма ещё не
  // построена).
  const rId = uid("u");
  State.units[rId] = {
    id: rId, ownerId: enemyPlayerId, type: "rifleman",
    x: 1440, y: 1010, targetX: null, targetY: null,
    hp: UnitDefs.rifleman.hp, maxHp: UnitDefs.rifleman.maxHp,
    state: "idle", cargo: 0,
    attackTargetId: null, attackCooldownLeft: 0, attackMoveMode: false,
    attackMoveHomeX: null, attackMoveHomeY: null, // ИИ №24
  };

  enemyFsm.phase = "ECONOMY";
  enemyFsm.phaseTimer = 0;
}

// Состояние конечного автомата вражеского ИИ. Вынесено в отдельный объект
// (не в State.players[enemyPlayerId]), т.к. это внутренняя логика "мозга"
// ИИ, а не игровые данные, которые нужно синхронизировать/отображать.
const enemyFsm = {
  phase: "ECONOMY",  // ECONOMY -> BUILDUP -> ATTACK -> REGROUP -> ECONOMY ...
  phaseTimer: 0,
  decisionTimer: 0,  // тикает независимо от фазы, троттлит "тяжёлые" решения (поиск целей и т.п.)
};

// ИИ №8: раньше это были жёстко зашитые const. Теперь значения берутся из
// EnemyDifficultyProfiles[SelectedEnemyProfile.difficulty] (js/01-config-state.js)
// — экран выбора сложности перед стартом кладёт туда выбор игрока. Имена
// переменных ENEMY_* оставлены прежними намеренно, чтобы не трогать остальной
// код файла (enemyEconomyStep/enemyBuildupStep/updateEnemyStub и т.п.),
// который уже на них ссылается. "normal" ниже — фолбэк на случай отсутствия
// выбора, бит-в-бит совпадает со старыми хардкод-значениями.
// ИИ №26: БАГФИКС "easy и hard не отличаются, ИИ всегда слабый и рано
// атакует" (репорт пользователя). Раньше _enemyDifficulty и ВСЕ производные
// ENEMY_* ниже были const верхнего уровня модуля — вычислялись РОВНО ОДИН
// РАЗ, в момент разбора этого файла браузером (<script src="06-enemy-ai.js">
// грузится ДО экрана выбора 10b и ДО 13-bootstrap.js, см. game.html). На тот
// момент SelectedEnemyProfile.difficulty ещё был дефолтным "normal"
// (js/01-config-state.js) — игрок физически не мог успеть выбрать сложность
// раньше загрузки скрипта. Экран выбора (10b) потом честно перезаписывал
// SelectedEnemyProfile.difficulty по клику игрока, но эти const этого уже
// никогда не видели — ИИ всю игру фактически жил с параметрами "normal"
// независимо от выбора на экране, отсюда и "easy/hard не отличаются", и
// "войско слишком слабое/атакует рано" (это и есть поведение normal,
// ощутимое на любом выбранном уровне).
// Фикс: та же идея, что уже применялась для enemyComposition() (тоже читает
// SelectedEnemyProfile КАЖДЫЙ раз, а не один раз при загрузке) — превращаем
// _enemyDifficulty и все ENEMY_* в функции, вызываемые там, где раньше
// стояло голое имя константы. Формулы/фолбэки не менялись ни на йоту,
// изменился только момент вычисления (лениво, при каждом обращении).
function currentEnemyDifficulty() {
  const key = (typeof SelectedEnemyProfile !== "undefined" && SelectedEnemyProfile.difficulty) || ENEMY_DEFAULT_DIFFICULTY;
  return (typeof EnemyDifficultyProfiles !== "undefined" && EnemyDifficultyProfiles[key])
    || { decisionInterval: 1500, workerTarget: 4, armyToAttack: 5, retreatHpFraction: 0.35,
         phaseDurationMultiplier: 1.0, pressureThreshold: 1.5, cautionThreshold: 1.4, maxArmyCap: 14 };
}
function ENEMY_DECISION_INTERVAL() { return currentEnemyDifficulty().decisionInterval; }
function ENEMY_ARMY_TO_ATTACK() { return currentEnemyDifficulty().armyToAttack; }
function ENEMY_RETREAT_HP_FRACTION() { return currentEnemyDifficulty().retreatHpFraction; }
function ENEMY_PHASE_DURATION_MULT() {
  const v = currentEnemyDifficulty().phaseDurationMultiplier;
  return v != null ? v : 1.0;
}
function ENEMY_PRESSURE_THRESHOLD() {
  const v = currentEnemyDifficulty().pressureThreshold;
  return v != null ? v : 1.5;
}
function ENEMY_CAUTION_THRESHOLD() {
  const v = currentEnemyDifficulty().cautionThreshold;
  return v != null ? v : 1.4;
}
function ENEMY_MAX_ARMY_CAP() {
  const v = currentEnemyDifficulty().maxArmyCap;
  return v != null ? v : 14;
}
// ИИ №27: новые поля профиля сложности (см. подробный комментарий у
// EnemyDifficultyProfiles, 01-config-state.js) — фолбэки НЕ меняют старое
// поведение (0/1/бесконечный кап), если поле не задано у кастомного/старого
// профиля.
function ENEMY_ARMY_ESCALATION_PER_2MIN() {
  const v = currentEnemyDifficulty().armyEscalationPer2Min;
  return v != null ? v : 0;
}
function ENEMY_ARMY_ESCALATION_CAP_MULT() {
  const v = currentEnemyDifficulty().armyEscalationCapMultiplier;
  return v != null ? v : 1.0;
}
function ENEMY_MIN_HEAVY_COMPOSITION() {
  const v = currentEnemyDifficulty().minHeavyComposition;
  return v != null ? v : 0;
}
function ENEMY_MIN_HEAVY_COMPOSITION_CAP() {
  const v = currentEnemyDifficulty().minHeavyCompositionCap;
  return v != null ? v : ENEMY_MIN_HEAVY_COMPOSITION();
}
function ENEMY_TECH_QUEUE_CAP_BONUS() {
  const v = currentEnemyDifficulty().techQueueCapBonus;
  return v != null ? v : 0;
}

// ИИ №27: "затянутость битвы = круче армия" (прямой запрос пользователя).
// matchElapsedMs накапливается в updateEnemyStub (см. ниже) тем же dt, что
// и остальные таймеры ИИ — независимый от enemyFsm.phaseTimer счётчик
// ОБЩЕГО времени с начала партии (не сбрасывается при смене фаз/рестарте
// цикла ECONOMY->BUILDUP->ATTACK->REGROUP). Не в State (это внутренняя
// логика "мозга" ИИ, как и enemyFsm — см. её же комментарий выше), поэтому
// не переживает релоад страницы, но переживает смену фаз/тиков в пределах
// партии, что и требуется.
const enemyMatchClock = { elapsedMs: 0 };

// Множитель эскалации по времени: 1.0 в начале партии, линейно растёт до
// armyEscalationCapMultiplier к моменту, когда прошло достаточно 2-минутных
// интервалов, дальше не растёт (потолок — прямой запрос пользователя: "нужен
// потолок, дальше не растёт"). При armyEscalationPer2Min===0 у профиля
// (easy/normal по умолчанию не нулевые, но кастомный профиль может быть)
// множитель всегда 1.0 — эскалации нет, старое поведение не ломается.
function armyEscalationMultiplier() {
  const perStep = ENEMY_ARMY_ESCALATION_PER_2MIN();
  const base = ENEMY_ARMY_TO_ATTACK();
  if (perStep <= 0 || base <= 0) return 1.0;
  const capMult = ENEMY_ARMY_ESCALATION_CAP_MULT();
  const steps = Math.floor(enemyMatchClock.elapsedMs / 120000); // 120000мс = 2 минуты
  const grown = base + perStep * steps;
  const capped = Math.min(grown, base * capMult);
  return capped / base;
}

// Эскалированный порог армии для перехода в ATTACK — базовый armyToAttack,
// растущий со временем по armyEscalationMultiplier(), зажатый снизу теми же
// правилами, что и раньше (BUILDUP-ветка в updateEnemyStub сама применяет
// isDominant/isOutmatched поверх этого числа, здесь только эскалация по
// времени, независимая от pressure).
function escalatedArmyToAttack() {
  return Math.round(ENEMY_ARMY_TO_ATTACK() * armyEscalationMultiplier());
}

// Требуемый минимум "тяжёлых" боевых единиц в атакующей армии — растёт от
// minHeavyComposition (начало партии) до minHeavyCompositionCap (после
// полной эскалации по времени), той же линейной интерполяцией, что и
// армия выше, только по отдельной паре мин/макс (не по множителю армии,
// т.к. minHeavyComposition может быть 0 — умножение на 0 никогда бы не
// выросло).
function escalatedMinHeavyComposition() {
  const minV = ENEMY_MIN_HEAVY_COMPOSITION();
  const capV = ENEMY_MIN_HEAVY_COMPOSITION_CAP();
  if (capV <= minV) return minV;
  const perStep = ENEMY_ARMY_ESCALATION_PER_2MIN();
  if (perStep <= 0) return minV;
  const capMult = ENEMY_ARMY_ESCALATION_CAP_MULT();
  // Тот же "прогресс" эскалации (0..1), что и у armyEscalationMultiplier,
  // выраженный по времени, а не по множителю армии (сама армия могла бы не
  // расти, если perStep=0, но здесь мы это уже отсекли выше).
  const stepsToCap = Math.max(1, Math.ceil((ENEMY_ARMY_TO_ATTACK() * (capMult - 1)) / perStep));
  const steps = Math.floor(enemyMatchClock.elapsedMs / 120000);
  const progress = Math.min(1, steps / stepsToCap);
  return Math.round(minV + (capV - minV) * progress);
}

// Считает "тяжёлые" боевые единицы ИИ (танки/тяжёлые танки/авиация) —
// сознательно не включает rifleman/rocketeer/grenadier/sniper/apc/worker:
// это именно "артиллерия/тяжёлая техника" из формулировки пользователя
// ("ИИ не научился копить артиллерию и нападать огромной армией"). apc
// намеренно НЕ считается тяжёлым — это дешёвая ранняя техника (см. её
// комментарий в 01-config-state.js), а не то, что пользователь имел в виду
// под "артиллерией".
// ИИ №34: добавлены gunship (второй летающий юнит, дороже aircraft) и
// artillery (дальнобойная САУ) — оба однозначно "тяжёлая техника" по духу
// того же критерия (дорогие, сильные ударные юниты, не ранняя лёгкая
// техника вроде apc и не расходная пехота). sapper НЕ добавлен сюда — это
// дешёвая пехота ближнего боя, тот же класс, что и остальная пехота.
const HEAVY_UNIT_TYPES = ["tank", "heavyTank", "aircraft", "gunship", "artillery"];
function countHeavyUnits(units) {
  return units.filter(u => HEAVY_UNIT_TYPES.includes(u.type)).length;
}

// ИИ №13: асимметрия фракций (TODO №3, последний оставшийся пункт).
// EnemyFactionProfiles[key].composition — набор параметров, влияющих на
// ЧТО и КОГДА строит/нанимает ИИ (см. подробный комментарий у
// EnemyFactionProfiles в js/01-config-state.js). Фолбэк на composition
// профиля "crimson" на случай отсутствия выбора/битого профиля — те же
// значения, что бит-в-бит воспроизводят старое поведение ИИ до №13, так
// что игра без выбора фракции ведёт себя как раньше.
const _DEFAULT_COMPOSITION = {
  warFactoryAfterBarracks: 1,
  infantryMix: { rifleman: 2, rocketeer: 1, grenadier: 1, sniper: 1, sapper: 1 }, // ИИ №22, ИИ №23, ИИ №34
  tankQueueCap: 2,
  aircraftQueueCap: 1,
  heavyTankQueueCap: 1, // ИИ №22
  apcQueueCap: 1, // ИИ №23
  gunshipQueueCap: 1, // ИИ №34
  artilleryQueueCap: 1, // ИИ №34
  preferTechOverInfantry: false,
  workerTargetBonus: 0,
};
function enemyComposition() {
  const factionKey = (typeof SelectedEnemyProfile !== "undefined" && SelectedEnemyProfile.faction) || "crimson";
  const faction = (typeof EnemyFactionProfiles !== "undefined" && EnemyFactionProfiles[factionKey]) || null;
  return (faction && faction.composition) || _DEFAULT_COMPOSITION;
}

// ИИ №29: ENEMY_WORKER_TARGET убрана вместе с юнитом worker. Экономика ИИ
// теперь ориентируется на ENEMY_REFINERY_TARGET (см. ниже, читает то же
// поле workerTarget/workerTargetBonus из тех же профилей — переименование
// данных в 01-config-state.js не требовалось: "сколько экономических
// юнитов держать" осталось тем же по смыслу числом, сменился только тип
// объекта, который под него строится).
function ENEMY_REFINERY_TARGET() {
  return currentEnemyDifficulty().workerTarget + (enemyComposition().workerTargetBonus || 0);
}

// ОПТИМИЗАЦИЯ (перф): enemyUnits()/enemyBuildings() раньше пересобирали
// Object.values(...).filter(...) с нуля НА КАЖДЫЙ вызов — а внутри одного
// decision-тика ИИ (enemyEconomyStep/enemyBuildupStep/enemyAttackStep и
// т.д., см. updateEnemyStub) они вызываются подряд по 5-8 раз на разные
// нужды. Результат теперь кэшируется на время одного gameTick (инвалидация
// по State.tick, см. 07-game-loop-combat.js) — если счётчик тика не
// изменился с прошлого вызова, отдаём тот же массив без пересчёта. Список
// живых юнитов/зданий не может измениться в середине одного тика (State
// мутируется только внутри gameTick), поэтому это безопасно и не меняет
// поведение ИИ ни на йоту — только не пересчитывает одно и то же по кругу.
let _enemyUnitsCacheTick = -1, _enemyUnitsCache = null;
function enemyUnits() {
  const tick = (typeof State !== "undefined" && State.tick) || 0;
  if (_enemyUnitsCacheTick !== tick) {
    _enemyUnitsCache = Object.values(State.units).filter(u => u.ownerId === enemyPlayerId && u.hp > 0);
    _enemyUnitsCacheTick = tick;
  }
  return _enemyUnitsCache;
}
let _enemyBuildingsCacheTick = -1, _enemyBuildingsCache = null;
function enemyBuildings() {
  const tick = (typeof State !== "undefined" && State.tick) || 0;
  if (_enemyBuildingsCacheTick !== tick) {
    _enemyBuildingsCache = Object.values(State.buildings).filter(b => b.ownerId === enemyPlayerId && b.hp > 0);
    _enemyBuildingsCacheTick = tick;
  }
  return _enemyBuildingsCache;
}
function enemyHq() { return enemyBuildings().find(b => b.type === "commandCenter") || null; }

// ИИ №25: "дожимать/отступать/копить" по факту раздела 2 (запрос
// пользователя: "ии противника должен дожимать если у меня войска слабое,
// отступать если сильное и уметь копить войска"). Раньше ИИ вообще не
// смотрел на состав/силу армии ИГРОКА — решения ATTACK/REGROUP принимались
// только по СВОЕЙ армии (число юнитов / доля HP), что и давало ощущение
// "одинаково легко на всех уровнях": ИИ не реагировал, если игрок слаб
// (не пользовался моментом), и не реагировал, если игрок силён (лез в лоб
// с тем же таймингом).
//
// estimateForceScore(units) — грубая, но осмысленная оценка боевой силы
// отряда: сумма по каждому юниту (currentHp * attackDamage / max(attackCooldown,1)),
// т.е. что-то вроде "текущий устойчивый DPS с поправкой на выживаемость"
// вместо простого подсчёта голов. Так тяжёлый танк на полном HP весит
// заметно больше, чем недобитый пехотинец, а быстрая скорострельная пехота
// не обесценивается по сравнению с редкими тяжёлыми ударами. НЕ учитывает
// dps зданий (turret) намеренно — сравниваем именно ПОЛЕВЫЕ армии, оборона
// базы уже отдельно покрыта turret+enemyDefendBaseStep.
function estimateForceScore(units) {
  let score = 0;
  units.forEach(u => {
    const def = UnitDefs[u.type];
    if (!def || !def.canAttack) return;
    const cd = Math.max(def.attackCooldown || 1000, 1);
    score += u.hp * (def.attackDamage || 0) / cd;
  });
  return score;
}

// ИИ не подчиняется фогу войны для собственных строительных/тактических
// решений (тот же принцип, что уже используется в isEnemyBuildPlacementValid
// выше — см. её комментарий про "ИИ не подчиняется фогу") — поэтому здесь
// честно берём ВСЕ живые боевые юниты игрока, а не только разведанные.
// Если в будущем понадобится "честный" ИИ, ограниченный своим фогом —
// нужно фильтровать по isWorldPointVisible/State.fog, сейчас сознательно
// не делаем (усложнение не было в запросе, а угадывание силы игрока по
// огрызкам разведки — отдельная, более сложная задача).
function playerCombatUnits() {
  return Object.values(State.units).filter(u => u.ownerId === localPlayerId && u.hp > 0 && UnitDefs[u.type] && UnitDefs[u.type].canAttack);
}

// forcePressureRatio() — во сколько раз своя армия сильнее армии игрока
// (>1 = ИИ сильнее, <1 = игрок сильнее). Возвращает Infinity, если у игрока
// вообще нет боевых юнитов (некого бояться — явный сигнал "дожимай"), и 0,
// если у самого ИИ боевых юнитов нет (нечем давить).
function forcePressureRatio() {
  const mine = estimateForceScore(enemyUnits().filter(u => UnitDefs[u.type] && UnitDefs[u.type].canAttack));
  const theirs = estimateForceScore(playerCombatUnits());
  if (theirs <= 0) return mine > 0 ? Infinity : 0;
  return mine / theirs;
}

// ИИ №29: enemyAssignHarvesters() убрана вместе с юнитом worker — добыча
// теперь пассивна через здание refinery (updateRefineries,
// 07-game-loop-combat.js), ИИ не нужно назначать цели харвеста.

// ИИ №29: та же credits-модель, что у игрока (updateRefineries начисляет
// кредиты владельцу автоматически по каждому живому refinery, независимо
// от того, чей он) — специального кода начисления денег ИИ здесь НЕ нужно,
// это уже общий путь. Здесь только решаем, ЧТО строить/нанимать на эти
// кредиты.
function enemyEconomyStep() {
  const player = State.players[enemyPlayerId];
  const hq = enemyHq();
  if (!hq) return; // штаб уничтожен — экономику разворачивать негде (см. футер про поражение ИИ)

  const refineryCount = enemyBuildings().filter(b => b.type === "refinery").length;
  const hasBarracks = enemyBuildings().some(b => b.type === "barracks");
  const hasPowerPlant = enemyBuildings().some(b => b.type === "powerPlant");

  // Приоритет 1: электростанция, если её ещё нет (иначе казармы могут не
  // хватить питания — модель питания уже считается в updatePowerAndUnitCounts()).
  if (!hasPowerPlant && player.credits >= BuildingDefs.powerPlant.cost) {
    enemyPlaceBuilding("powerPlant");
    return;
  }
  // Приоритет 2: казармы, если их ещё нет — без них армию не набрать.
  if (!hasBarracks && player.credits >= BuildingDefs.barracks.cost) {
    enemyPlaceBuilding("barracks");
    return;
  }
  // ИИ №29: приоритет 3 — здания refinery, пока их меньше целевого числа,
  // вместо юнитов-рабочих (см. ENEMY_REFINERY_TARGET выше, та же цифра из
  // профиля сложности/фракции, что и раньше у workerTarget). Ставится
  // через enemyPlaceBuilding — тот же путь, что и powerPlant/barracks
  // выше, а не через очередь найма юнитов у hq.
  if (refineryCount < ENEMY_REFINERY_TARGET() && player.credits >= BuildingDefs.refinery.cost) {
    enemyPlaceBuilding("refinery");
    return;
  }
  // ИИ №11: приоритет 3.5 — завод техники, если казармы уже есть, а
  // завода ещё нет (TODO №3). Ставлю ПОСЛЕ рабочих и ПЕРЕД турелью:
  // экономика важнее, но танки — сильный довесок к армии, отдаём им
  // приоритет выше "подушки безопасности"-турели.
  const hasWarFactory = enemyBuildings().some(b => b.type === "warFactory");
  if (hasBarracks && !hasWarFactory && player.credits >= BuildingDefs.warFactory.cost) {
    enemyPlaceBuilding("warFactory");
    return;
  }
  // ИИ №12: приоритет 3.6 — аэродром, после завода техники, до турели.
  // Та же логика приоритетов, что у warFactory (ИИ №11): экономика и
  // база важнее, но авиация — сильный довесок к армии, отдаём ей
  // приоритет выше "подушки безопасности"-турели. Требует warFactory
  // построенным первым (наземная техника — более базовый род войск,
  // авиация — следующая ступень эскалации, как в каноне серии).
  const hasAirfield = enemyBuildings().some(b => b.type === "airfield");
  if (hasWarFactory && !hasAirfield && player.credits >= BuildingDefs.airfield.cost) {
    enemyPlaceBuilding("airfield");
    return;
  }
  // ИИ №5: приоритет 4 — одна турель на базу, если казармы уже есть, но
  // турели ещё нет. [ИИ №13] Техно-фракция (comp.preferTechOverInfantry,
  // сейчас только "iron") специально ОТКЛАДЫВАЕТ турель, пока warFactory
  // ещё не построен — она предпочитает потратить следующие свободные
  // кредиты на завод техники, а не на "подушку безопасности"-турель, даже
  // если завод пока недоступен по кредитам в этом самом тике (просто ждёт
  // накопления, не переключаясь на турель как на запасной вариант). Для
  // остальных фракций (preferTechOverInfantry:false) порядок совпадает со
  // старым бит-в-бит: турель сразу после барака, до завода не привязана.
  const comp = enemyComposition();
  const turretBlockedByTechPreference = comp.preferTechOverInfantry && !hasWarFactory;
  // ИИ №46 (по прямому запросу пользователя, "лимит турелей 20") — та же
  // общая проверка countOwnerTurrets/TURRET_LIMIT_PER_PLAYER, что и у
  // игрока (10-hud.js, 01-config-state.js). ИИ и так строит максимум одну
  // турель здесь (см. enemyBuildings().some(...) ниже), лимит 20 на
  // практике не должен срабатывать для этой ветки — добавлен для
  // консистентности правила между игроком и ИИ на случай, если поведение
  // ИИ когда-нибудь расширят до нескольких турелей за партию.
  if (hasBarracks && !turretBlockedByTechPreference &&
      !enemyBuildings().some(b => b.type === "turret") &&
      countOwnerTurrets(enemyPlayerId) < TURRET_LIMIT_PER_PLAYER &&
      player.credits >= BuildingDefs.turret.cost) {
    enemyPlaceBuilding("turret");
    return;
  }
  // Приоритет 5: если казармы есть — качаем армию, в т.ч. танки из
  // завода техники (ИИ №11) и aircraft из аэродрома (ИИ №12), если они
  // уже построены (см. enemyBuildupStep). [ИИ №13] Состав и лимиты этой
  // армии теперь зависят от comp (infantryMix/tankQueueCap/
  // aircraftQueueCap выбранной фракции) — см. enemyBuildupStep(), которая
  // сама заново читает enemyComposition().
}

// ИИ №21: РЕШЁН открытый TODO №1 из PROMPT_FOR_NEXT_AI.md ("enemyPlaceBuilding
// не проверяет коллизии зданий ИИ друг с другом/ресурсами — риск наложения
// построек"). Раньше здесь бралась одна случайная точка по кольцу вокруг
// штаба БЕЗ какой-либо проверки — постройки ИИ могли наложиться друг на
// друга или на ресурсную ноду.
//
// isEnemyBuildPlacementValid() — это НАМЕРЕННО отдельная копия геометрии
// коллизий из isBuildPlacementValid() (js/10-hud.js), НЕ вызов той функции
// напрямую. Две причины:
//  1) порядок подключения скриптов (см. game.html/00-header-comment.js) —
//     06-enemy-ai.js грузится ДО 10-hud.js, так что isBuildPlacementValid
//     физически ещё не объявлена в момент объявления функций этого файла
//     (тот же порядок соблюдён и во время игры, но полагаться на "он же
//     объявлен к моменту вызова" было бы скрытой связью между модулем ИИ
//     и HUD-модулем игрока, которых явно разносили по разным файлам всю
//     историю проекта — см. раздел "правила" в PROMPT_FOR_NEXT_AI.md);
//  2) семантика для ИИ ДРУГАЯ: ИИ не подчиняется фогу войны (строит и там,
//     где сам не "видит" в терминах State.fog) — isBuildPlacementValid,
//     наоборот, обязана проверять isWorldPointVisible за игрока (см. её
//     комментарий и раздел "грабли" в PROMPT_FOR_NEXT_AI.md — это был баг,
//     исправленный явно, откатывать нельзя). Слепое переиспользование
//     чужой функции означало бы либо дублировать её и убирать фог-проверку
//     (то же дублирование, что мы делаем сейчас, только более хрупкое — легко
//     забыть при будущей правке 10-hud.js), либо звать её "as is" и
//     получить баг "ИИ не может строить в тумане над своей же базой".
//     Прямое дублирование геометрии — самый явный вариант.
//
// Проверяем: (а) не пересекается с уже существующими зданиями — своими,
// вражескими (игрока) и remote-тенями других игроков, тем же способом,
// что и у игрока (прямоугольники + BUILD_GAP), (б) не слишком близко к
// узлам ресурсов. Рельеф не проверяется — как и у игрока, карта плоская.
// ПРАВКА (по прямому запросу пользователя, см. BUILD_GAP в 10-hud.js) —
// занулено вместе с BUILD_GAP игрока: с зазором >0 здания ИИ, снапнутые
// на ту же тайловую сетку (snapBuildingCenterToGrid), не могли встать в
// соседние клетки друг с другом, из-за чего застройка ИИ выглядела рыхлее,
// чем должна быть при плотном кучковании (см. enemyPlaceBuilding).
const ENEMY_BUILD_GAP = 0; // тот же зазор, что BUILD_GAP у игрока (10-hud.js) — для консистентности карты
function isEnemyBuildPlacementValid(key, wx, wy) {
  const def = BuildingDefs[key];
  if (!def) return false;

  const halfW = def.w * GameConfig.tileSize / 2 + ENEMY_BUILD_GAP;
  const halfH = def.h * GameConfig.tileSize / 2 + ENEMY_BUILD_GAP;

  for (const b of Object.values(State.buildings)) {
    const bdef = BuildingDefs[b.type];
    if (!bdef) continue;
    const bHalfW = bdef.w * GameConfig.tileSize / 2;
    const bHalfH = bdef.h * GameConfig.tileSize / 2;
    const overlapX = Math.abs(wx - b.x) < (halfW + bHalfW);
    const overlapY = Math.abs(wy - b.y) < (halfH + bHalfH);
    if (overlapX && overlapY) return false;
  }

  for (const r of Object.values(State.resources)) {
    if (dist(wx, wy, r.x, r.y) < Math.max(halfW, halfH) + 18) return false;
  }

  if (State.remoteGhosts) {
    for (const pdata of Object.values(State.remoteGhosts)) {
      if (!pdata || !pdata.buildings) continue;
      for (const b of Object.values(pdata.buildings)) {
        const bdef = BuildingDefs[b.type];
        if (!bdef) continue;
        const bHalfW = bdef.w * GameConfig.tileSize / 2;
        const bHalfH = bdef.h * GameConfig.tileSize / 2;
        const overlapX = Math.abs(wx - b.x) < (halfW + bHalfW);
        const overlapY = Math.abs(wy - b.y) < (halfH + bHalfH);
        if (overlapX && overlapY) return false;
      }
    }
  }

  return true;
}

// Размещение здания ИИ: по кольцу вокруг штаба со случайным смещением
// (как раньше), но теперь с реальной проверкой коллизий вместо слепой
// одной попытки. Стратегия поиска — расширяющиеся кольца: сперва пробуем
// N случайных точек в исходном радиусе (140-220px от штаба, как было),
// если ни одна не подошла — увеличиваем радиус кольца и пробуем снова, до
// потолка ENEMY_PLACEMENT_MAX_RADIUS. Это гарантирует, что ИИ рано или
// поздно найдёт свободное место по мере роста базы (плотная застройка
// у штаба закончится — кольцо расширится наружу), а не будет вечно
// пытаться втиснуть здание в занятое место или молча ничего не строить.
// ENEMY_PLACEMENT_RING_ATTEMPTS — предохранитель по бюджету попыток за
// один вызов (это происходит раз в decision-тик ИИ, не в gameTick, так
// что цена нескольких лишних Math.random()+проверок пренебрежимо мала).
const ENEMY_PLACEMENT_RING_ATTEMPTS = 12;
const ENEMY_PLACEMENT_MAX_RADIUS = 700; // после этого сдаёмся до следующего decision-тика, не зависаем навсегда
function enemyPlaceBuilding(key) {
  const def = BuildingDefs[key];
  const player = State.players[enemyPlayerId];
  const hq = enemyHq();
  if (!hq || player.credits < def.cost) return;

  let bx = null, by = null;
  for (let ringRadius = 140; ringRadius <= ENEMY_PLACEMENT_MAX_RADIUS; ringRadius += 90) {
    for (let attempt = 0; attempt < ENEMY_PLACEMENT_RING_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = ringRadius + Math.random() * 80;
      // ИИ (по прямому запросу пользователя, "здания [любые] ставятся строго
      // в клетки") — снапаем кандидата на тайловую сетку ДО проверки
      // валидности, тем же snapBuildingCenterToGrid, что и у игрока
      // (02-utils-canvas.js) — единая сетка для обеих сторон. key здесь
      // никогда не "wall" (стены у ИИ строит отдельная enemyWallStep/
      // enemyWallStepClustered, см. 18-walls.js/19-...js), но исключение
      // добавлено для симметрии с остальными местами, где вызывается эта
      // функция снапа.
      const raw = { x: hq.x + Math.cos(angle) * radius, y: hq.y + Math.sin(angle) * radius };
      const snapped = (key !== "wall" && typeof snapBuildingCenterToGrid === "function")
        ? snapBuildingCenterToGrid(key, raw.x, raw.y) : raw;
      const tx = snapped.x, ty = snapped.y;
      if (isEnemyBuildPlacementValid(key, tx, ty)) { bx = tx; by = ty; break; }
    }
    if (bx != null) break;
  }

  if (bx == null) {
    // Не нашли места даже на максимальном радиусе за этот decision-тик —
    // не тратим кредиты и не спавним постройку поверх другой. Просто
    // ждём: на следующий вызов (следующий decision-тик, либо после того
    // как что-то из построек уничтожат) возможно освободится место.
    // Не логируем каждый раз (decision-тик частый, лог бы засорился) —
    // это внутренний retry, а не ошибка, требующая внимания игрока.
    return;
  }

  player.credits -= def.cost;
  const id = uid("b");
  // ИИ №46: та же механика возведения, что у построек игрока (10-hud.js) —
  // здание ИИ тоже появляется сразу (можно атаковать), но не рабочее, пока
  // не пройдёт CONSTRUCTION_MS_BUILDING (см. 01-config-state.js). key здесь
  // никогда не "wall" (см. комментарий про snapBuildingCenterToGrid выше в
  // этой же функции) — постройка стен ИИ идёт отдельным путём, enemyWallStep
  // (18-walls.js), которая уже сама выставляет constructionMsLeft/
  // CONSTRUCTION_MS_WALL.
  State.buildings[id] = {
    id, ownerId: enemyPlayerId, type: key,
    x: bx, y: by, hp: def.hp, maxHp: def.hp,
    rallyX: bx + 30, rallyY: by + 30, buildQueue: [],
    constructionMsLeft: CONSTRUCTION_MS_BUILDING, constructionTotalMs: CONSTRUCTION_MS_BUILDING,
  };
  logMsg(`Противник строит: ${def.label}`, "enemy");
}

function enemyQueueUnit(key, building) {
  // ИИ №46 (та же правка, что и в tryTrainUnit, 10-hud.js, "пока строится
  // здание... само здание не рабочее"): здание с constructionMsLeft>0 ещё
  // не готово и не может ничего производить. Раньше эта проверка была
  // добавлена только в tryTrainUnit (найм игрока) — enemyQueueUnit оставался
  // непропатченным, из-за чего ИИ мог нанимать юнитов в только что
  // заложенном, ещё строящемся здании (casus: barracks.length===0 выше по
  // коду проверяет только наличие здания, не его готовность). Молчаливый
  // return здесь безопасен: кредиты списываются НИЖЕ этой проверки, так что
  // при отказе они не тратятся — ИИ просто повторит попытку на следующем
  // decision-тике (см. вызовы в enemyBuildupStep).
  if (building.constructionMsLeft > 0) return;
  const def = UnitDefs[key];
  const player = State.players[enemyPlayerId];
  if (player.credits < def.cost) return;
  player.credits -= def.cost;
  if (!building.buildQueue) building.buildQueue = [];
  building.buildQueue.push({ unitType: key, msLeft: def.buildTime, totalMs: def.buildTime });
}

// Фаза BUILDUP: копим боевую армию через казармы (если они есть), продолжая
// параллельно поддерживать экономику (иначе кредиты кончатся и найм встанет).
// ИИ №13: rifleman/rocketeer больше не чередуются по фиксированной
// формуле `combatCount % 3 === 2` — она давала ровно один и тот же
// микс ~2:1 для всех фракций. Теперь микс задаёт comp.infantryMix
// (веса, не проценты) выбранной фракции. Детерминированный выбор без
// Math.random(): держим бегущий счётчик "накопленной задолженности" по
// каждому типу в enemyFsm (infantryDebt), каждый вызов добавляем к
// обоим типам их вес и нанимаем тот, у кого сейчас больше накоплено —
// это распределяет найм пропорционально весам без рандома и без дрейфа
// (в отличие от %-формулы, которая от веса вообще не зависела).
//
// ИИ №22: добавлен grenadier (тяжёлая пехота) как третий тип в тот же
// накопительный механизм — обобщил на произвольное число ключей вместо
// двух хардкод-полей, чтобы не плодить if/else на каждый новый тип пехоты
// в будущем. Если mix.grenadier не задан у фракции (см. EnemyFactionProfiles,
// 01-config-state.js) — вес 0, grenadier просто никогда не наберёт "долг"
// и не будет выбран, это безопасный фолбэк без правки существующих фракций.
// ИИ №23: добавлен sniper четвёртым типом тем же приёмом (просто новая
// запись в types[] + debt{}) — механизм уже был обобщён под "произвольное
// число ключей" в ИИ №22, так что добавление ещё одного типа не потребовало
// новых if/else, только строчку в массиве и в инициализации debt.
// ИИ №34: добавлен sapper пятым типом тем же приёмом.
function pickInfantryType(mix) {
  const types = ["rifleman", "rocketeer", "grenadier", "sniper", "sapper"];
  if (!enemyFsm.infantryDebt) enemyFsm.infantryDebt = { rifleman: 0, rocketeer: 0, grenadier: 0, sniper: 0, sapper: 0 };
  const debt = enemyFsm.infantryDebt;
  types.forEach(k => { if (debt[k] == null) debt[k] = 0; debt[k] += mix[k] || 0; });
  let type = types[0], bestDebt = -Infinity;
  types.forEach(k => { if ((mix[k] || 0) > 0 && debt[k] > bestDebt) { bestDebt = debt[k]; type = k; } });
  const totalWeight = types.reduce((sum, k) => sum + (mix[k] || 0), 0);
  debt[type] -= totalWeight; // сбрасываем "долг" выбранного типа
  return type;
}

// ИИ №25: сам найм здесь НЕ ограничен ENEMY_MAX_ARMY_CAP намеренно — лимит
// на общий размер армии применяется в updateEnemyStub при решении "пора ли
// переходить в ATTACK" (см. ниже), а не здесь. Если бы мы блокировали найм
// прямо тут по достижении капа, ИИ на hard (maxArmyCap=22) перестал бы
// готовить резерв заранее и упирался бы в кап только в момент атаки —
// хуже для "копит войска" из запроса пользователя. Здесь найм продолжается,
// пока хватает кредитов и очередь здания не переполнена (как раньше).
function enemyBuildupStep() {
  enemyEconomyStep(); // экономика продолжает работать фоном во всех фазах, кроме ATTACK
  const player = State.players[enemyPlayerId];
  const barracks = enemyBuildings().filter(b => b.type === "barracks");
  const comp = enemyComposition();
  if (barracks.length === 0) return;
  // [ИИ №13] Микс rifleman/rocketeer теперь фракционный (см.
  // pickInfantryType выше и comp.infantryMix, js/01-config-state.js).
  // crimson (rifleman:2, rocketeer:1) воспроизводит старую формулу
  // combatCount % 3 === 2 практически один-в-один по частоте.
  const wantType = pickInfantryType(comp.infantryMix || { rifleman: 2, rocketeer: 1 });
  const def = UnitDefs[wantType];
  if (player.credits >= def.cost) {
    // здание с наименьшей текущей очередью — грубая балансировка нагрузки между казармами
    const target = barracks.slice().sort((a, b) => (a.buildQueue?.length || 0) - (b.buildQueue?.length || 0))[0];
    if ((target.buildQueue?.length || 0) < 3) enemyQueueUnit(wantType, target);
  }

  // ИИ №11/[ИИ №13]: если есть завод техники — добавляем танк отдельно от
  // пехотного чередования выше (танк дорогой, не хотим, чтобы он вытеснял
  // пехоту из очереди казармы — у него своя очередь). Лимит очереди теперь
  // из comp.tankQueueCap (техно-фракция iron=3, рой viridian=1, crimson=2
  // как раньше).
  // ИИ №27: + techBonus (ENEMY_TECH_QUEUE_CAP_BONUS, зависит от СЛОЖНОСТИ,
  // не фракции, см. 01-config-state.js) — по прямому запросу пользователя
  // ("ИИ не копит артиллерию, нападает пехотой с редким танком"). Раньше
  // лимиты очередей техники зависели ТОЛЬКО от фракции, сложность на них
  // вообще не влияла — hard и easy штамповали технику одинаково скромно.
  const techBonus = ENEMY_TECH_QUEUE_CAP_BONUS();
  const warFactories = enemyBuildings().filter(b => b.type === "warFactory");
  if (warFactories.length > 0) {
    const wf = warFactories[0];
    const tankDef = UnitDefs.tank;
    const cap = (comp.tankQueueCap != null ? comp.tankQueueCap : 2) + techBonus;
    if (player.credits >= tankDef.cost && (wf.buildQueue?.length || 0) < cap) {
      enemyQueueUnit("tank", wf);
    }
    // ИИ №22: heavyTank — отдельный, более скромный лимит очереди
    // (comp.heavyTankQueueCap, дефолт 1), т.к. это дорогой юнит (850кр) —
    // не хотим, чтобы он монополизировал очередь warFactory за счёт
    // обычных tank. Проверяется независимо от блока tank выше — оба могут
    // стоять в очереди одновременно, каждый со своим потолком.
    const heavyDef = UnitDefs.heavyTank;
    const heavyCap = (comp.heavyTankQueueCap != null ? comp.heavyTankQueueCap : 1) + techBonus;
    const heavyInQueue = (wf.buildQueue || []).filter(o => o.unitType === "heavyTank").length;
    if (player.credits >= heavyDef.cost && heavyInQueue < heavyCap) {
      enemyQueueUnit("heavyTank", wf);
    }
    // ИИ №23: apc — третий независимый счётчик очереди той же warFactory
    // (comp.apcQueueCap, дефолт 1), тем же паттерном, что и heavyTank выше.
    // apc дешевле tank (380 против 500) — намеренно проверяется ПОСЛЕ
    // tank/heavyTank в порядке кода, чтобы при нехватке кредитов на всё
    // сразу приоритет визуально совпадал с порядком объявления (не влияет
    // на исход, т.к. все три блока независимо проверяют свои кредиты и
    // лимиты, но так проще читать код сверху вниз). apc НЕ получает
    // techBonus (ИИ №27) — это лёгкая ранняя техника, а не "артиллерия" из
    // запроса пользователя, не хотим, чтобы hard заваливал apc вместо
    // настоящей тяжёлой техники.
    const apcDef = UnitDefs.apc;
    const apcCap = comp.apcQueueCap != null ? comp.apcQueueCap : 1;
    const apcInQueue = (wf.buildQueue || []).filter(o => o.unitType === "apc").length;
    if (player.credits >= apcDef.cost && apcInQueue < apcCap) {
      enemyQueueUnit("apc", wf);
    }

    // ИИ №34: artillery — четвёртый независимый счётчик очереди той же
    // warFactory (comp.artilleryQueueCap, дефолт 1), тот же паттерн, что
    // heavyTank/apc выше. Дальнобойная САУ ПОЛУЧАЕТ techBonus (в отличие
    // от apc) — это "тяжёлая техника" по духу запроса пользователя из
    // ИИ №27 ("копить артиллерию"), буквально одноимённый юнит.
    const artilleryDef = UnitDefs.artillery;
    const artilleryCap = (comp.artilleryQueueCap != null ? comp.artilleryQueueCap : 1) + techBonus;
    const artilleryInQueue = (wf.buildQueue || []).filter(o => o.unitType === "artillery").length;
    if (player.credits >= artilleryDef.cost && artilleryInQueue < artilleryCap) {
      enemyQueueUnit("artillery", wf);
    }
  }

  // ИИ №12/[ИИ №13]: аналогично для аэродрома/aircraft. Лимит очереди из
  // comp.aircraftQueueCap (техно-фракция iron=2, остальные=1 как раньше) —
  // aircraft дороже (700 против 500) и сильнее по урону/дальности, не
  // техно-фракции не должны разом штамповать эскадрилью, растрачивая всю
  // экономику на один род войск. ИИ №27: + techBonus, см. коммент у tank выше.
  const airfields = enemyBuildings().filter(b => b.type === "airfield");
  if (airfields.length > 0) {
    const af = airfields[0];
    const aircraftDef = UnitDefs.aircraft;
    const cap = (comp.aircraftQueueCap != null ? comp.aircraftQueueCap : 1) + techBonus;
    if (player.credits >= aircraftDef.cost && (af.buildQueue?.length || 0) < cap) {
      enemyQueueUnit("aircraft", af);
    }

    // ИИ №34: gunship — независимый счётчик очереди того же airfield
    // (comp.gunshipQueueCap, дефолт 1), тот же паттерн, что и aircraft
    // выше — оба типа могут стоять в очереди одновременно, каждый со
    // своим лимитом. Самый дорогой юнит в игре (950), получает techBonus.
    const gunshipDef = UnitDefs.gunship;
    const gunshipCap = (comp.gunshipQueueCap != null ? comp.gunshipQueueCap : 1) + techBonus;
    const gunshipInQueue = (af.buildQueue || []).filter(o => o.unitType === "gunship").length;
    if (player.credits >= gunshipDef.cost && gunshipInQueue < gunshipCap) {
      enemyQueueUnit("gunship", af);
    }
  }
}

// Фаза ATTACK: собираем всю боеспособную армию и явно приказываем ей
// attack-move к штабу игрока (или к любому его зданию, если штаб уже снесён).
// ИИ №24: теперь явно выставляет u.attackMoveHomeX/Y на точку attack-move
// (та же цель, что и setUnitDestination) — раньше это поле не существовало,
// и updateCombat (07-game-loop-combat.js) полагался на фолбэк
// (запоминает pathGoalX/Y при первом обнаружении attackMoveMode без home).
// Явная простановка здесь чище фолбэка и ничего не ломает — просто задаёт
// то же самое значение чуть раньше, до первого тика updateCombat.
function enemyAttackStep() {
  const combat = enemyUnits().filter(u => UnitDefs[u.type] && UnitDefs[u.type].canAttack);
  if (combat.length === 0) { enemyFsm.phase = "BUILDUP"; enemyFsm.phaseTimer = 0; return; }

  const playerBuildings = Object.values(State.buildings).filter(b => b.ownerId === localPlayerId && b.hp > 0);
  if (playerBuildings.length === 0) return; // игрок без зданий — атаковать некуда, ждём в этой фазе
  const hq = playerBuildings.find(b => b.type === "commandCenter") || playerBuildings[0];

  combat.forEach(u => {
    // ИИ №24: БАГФИКС "ИИ стоит истуканом" (репорт пользователя) —
    // раньше юнит переприказывался ТОЛЬКО если state==="idle" && !attackTargetId.
    // Проблема: юнит мог дойти до точки attack-move, физически стать idle
    // (блок движения в 07 переключает state в "idle" по прибытии), но
    // findNearestEnemyInRange в updateCombat в этот же момент не найти
    // никого рядом (враг успел уйти/умереть) — юнит оставался в чистом
    // idle без attackTargetId и БЕЗ нового приказа, потому что следующий
    // enemyAttackStep срабатывает только раз в ENEMY_DECISION_INTERVAL, и
    // если к тому моменту его state снова не строго "idle без цели" (или
    // если он уже получал этот же hq как pathGoal раньше и код считал его
    // "уже идущим") — переприказ не срабатывал. Теперь условие явно
    // покрывает оба случая: юнит либо ещё не в attack-move вовсе, либо уже
    // ПРИБЫЛ (idle) и ждёт нового приказа — переприказываем в обоих.
    const arrivedAndIdle = u.state === "idle" && !u.attackTargetId;
    if (arrivedAndIdle) {
      u.attackMoveMode = true;
      const tx = hq.x + (Math.random() * 60 - 30), ty = hq.y + (Math.random() * 60 - 30);
      setUnitDestination(u, tx, ty);
      u.attackMoveHomeX = tx;
      u.attackMoveHomeY = ty;
      u.state = "moving";
    }
  });
}

// ИИ №24: НОВОЕ — "оборона базы" (репорт пользователя: "враг иногда просто
// стоит у моей базы"/"либо атаковал, либо защищал базу"). Раньше ИИ считал
// защиту базы полностью пассивной — turret (если построена) стреляла сама
// (updateDefensiveStructures, 07), но обычные боевые юниты рядом со своим
// штабом никак не реагировали на вторгшегося врага, если не были явно в
// attack-move/idle-автоагро в нужный момент (см. updateCombat — автопоиск
// срабатывает только при state==="idle" || attackMoveMode, а юнит,
// стоящий в REGROUP/ECONOMY без явного приказа, вполне может быть в
// state==="idle" и в теории сам должен был бы это подхватить — но на
// практике фаза REGROUP/ECONOMY не вызывает НИКАКОГО move-приказа для
// простаивающих боевых юнитов, они просто рождаются на rally-точке и
// остаются там навсегда в чистом idle без победы автопоиска, если враг
// появился уже ПОСЛЕ того как юнит "осел" — таких случаев автопоиск не
// покрывает, т.к. autoAggro срабатывает по radius, а не по факту "я
// вообще ничего не делаю"). Вызывается из updateEnemyStub КАЖДЫЙ
// decision-тик, независимо от текущей фазы enemyFsm (ECONOMY/BUILDUP/
// REGROUP) — оборона своей базы не должна ждать своей очереди в конечном
// автомате, это отдельный, более срочный приоритет, чем "цикл строительства".
const ENEMY_BASE_DEFEND_RADIUS = 260; // должен быть заметно больше среднего attackRange, чтобы юнит успел среагировать до того, как враг дойдёт до самого штаба
function enemyDefendBaseStep() {
  const hq = enemyHq();
  if (!hq) return;
  const idleCombatUnits = enemyUnits().filter(u => {
    const def = UnitDefs[u.type];
    return def && def.canAttack && u.state === "idle" && !u.attackTargetId && !u.attackMoveMode;
  });
  if (idleCombatUnits.length === 0) return;

  idleCombatUnits.forEach(u => {
    const d = dist(u.x, u.y, hq.x, hq.y);
    if (d > ENEMY_BASE_DEFEND_RADIUS) return; // юнит слишком далеко от штаба — это не "охрана базы", а что-то другое, не трогаем
    const def = UnitDefs[u.type];
    const invader = findNearestEnemyInRange(u, ENEMY_BASE_DEFEND_RADIUS);
    if (!invader) return; // никто не вторгся — юниту действительно нечего делать, оставляем как есть (не суетимся зря)
    // Приказываем attack-move ПРЯМО НА текущую позицию юнита (не на hq) —
    // юнит и так уже рядом с базой, нам нужно просто ВКЛЮЧИТЬ его боевую
    // логику (attackMoveMode) и дать updateCombat автопоиском подхватить
    // invader на следующем тике, а не гнать юнита куда-то ещё.
    u.attackMoveMode = true;
    u.attackMoveHomeX = u.x;
    u.attackMoveHomeY = u.y;
    setUnitDestination(u, u.x, u.y);
    u.state = "idle"; // остаётся на месте (цель и так уже "здесь"), но attackMoveMode включает автопоиск в updateCombat
  });
}

// Фаза REGROUP: короткая пауза после неудачной/дорогой атаки — просто
// нанимаем/копим, не атакуя, пока не пройдёт таймер (см. ENEMY_PHASE_DURATIONS).
function enemyRegroupStep() {
  enemyEconomyStep();
}

// ИИ №25: базовые длительности, помноженные на ENEMY_PHASE_DURATION_MULT
// выбранной сложности (js/01-config-state.js) — hard (0.7) проходит цикл
// быстрее и агрессивнее, easy (1.3) дольше "раскачивается". База (1.0 у
// normal) равна прежним хардкод-значениям бит-в-бит.
const ENEMY_PHASE_DURATIONS_BASE = {
  ECONOMY: 15000,
  BUILDUP: 20000,
  ATTACK: 30000,   // максимум — если за это время не выиграли и не проиграли армию, отступаем сами
  REGROUP: 10000,
};
// ИИ №26: тоже был объект-const, замороженный на momente загрузки файла с
// прежним ENEMY_PHASE_DURATION_MULT (тогда ещё const) — та же причина, тот
// же фикс. Теперь функция, пересчитывающая длительности по ТЕКУЩЕМУ
// множителю сложности при каждом вызове.
function currentPhaseDurations() {
  const mult = ENEMY_PHASE_DURATION_MULT();
  return {
    ECONOMY: ENEMY_PHASE_DURATIONS_BASE.ECONOMY * mult,
    BUILDUP: ENEMY_PHASE_DURATIONS_BASE.BUILDUP * mult,
    ATTACK: ENEMY_PHASE_DURATIONS_BASE.ATTACK * mult,
    REGROUP: ENEMY_PHASE_DURATIONS_BASE.REGROUP * mult,
  };
}

function updateEnemyStub(dt) {
  enemyFsm.phaseTimer += dt;
  enemyFsm.decisionTimer += dt;
  // ИИ №27: общий счётчик времени партии для эскалации требований армии
  // (см. armyEscalationMultiplier/escalatedArmyToAttack/
  // escalatedMinHeavyComposition выше) — тикает КАЖДЫЙ вызов, независимо от
  // decisionInterval-троттлинга ниже (иначе на hard с decisionInterval=800
  // время партии считалось бы медленнее, чем на easy с 2600 — эскалация не
  // должна зависеть от того, как часто ИИ "думает").
  enemyMatchClock.elapsedMs += dt;
  if (enemyFsm.decisionTimer < ENEMY_DECISION_INTERVAL()) return;
  enemyFsm.decisionTimer = 0;

  const combat = enemyUnits().filter(u => UnitDefs[u.type] && UnitDefs[u.type].canAttack);

  // ИИ №24: оборона базы проверяется КАЖДЫЙ decision-тик, независимо от
  // текущей фазы enemyFsm — см. обоснование в комментарии над
  // enemyDefendBaseStep выше (простаивающий боевой юнит рядом со штабом не
  // должен ждать своей очереди в ECONOMY/BUILDUP/REGROUP, чтобы среагировать
  // на вторжение).
  enemyDefendBaseStep();

  // ИИ №25: pressure — во сколько раз своя армия сильнее армии игрока
  // (>1 = ИИ сильнее, см. forcePressureRatio выше). Считаем один раз за
  // decision-тик и переиспользуем во всех ветках switch ниже, чтобы решения
  // BUILDUP->ATTACK и ATTACK->REGROUP были согласованы между собой в рамках
  // одного и того же "снимка" сил, а не дёргались на разные значения из-за
  // изменившегося State между переключениями.
  // ИИ №26: durations — тоже один снимок на весь decision-тик (см.
  // currentPhaseDurations выше), чтобы ECONOMY/BUILDUP/ATTACK/REGROUP ниже
  // сверялись с одними и теми же числами, а не пересчитывали функцию заново
  // в каждой ветке (не критично для корректности, но так дешевле и чище).
  const pressure = forcePressureRatio();
  const isDominant = pressure >= ENEMY_PRESSURE_THRESHOLD();   // игрок явно слабее — самое время дожимать
  const isOutmatched = pressure > 0 && pressure <= (1 / ENEMY_CAUTION_THRESHOLD()); // игрок явно сильнее — пора быть осторожнее
  const durations = currentPhaseDurations();

  switch (enemyFsm.phase) {
    case "ECONOMY":
      enemyEconomyStep();
      if (enemyFsm.phaseTimer >= durations.ECONOMY) {
        enemyFsm.phase = "BUILDUP"; enemyFsm.phaseTimer = 0;
      }
      break;
    case "BUILDUP": {
      enemyBuildupStep();
      // ИИ №25: требуемый порог армии для перехода в ATTACK больше не
      // константа — если ИИ явно доминирует (isDominant), понижаем порог
      // (минимум 2 юнита, чтобы не атаковать буквально одним раненым
      // rifleman) — это и есть "дожимание": слабая армия игрока не должна
      // давать ему передышку на полноценный ENEMY_ARMY_TO_ATTACK. Если же
      // игрок явно сильнее (isOutmatched) — требуем накопить БОЛЬШЕ обычного
      // порога (вплоть до ENEMY_MAX_ARMY_CAP), не лезть в лоб с недостаточной
      // армией — это и есть "копить войска, если сильное [войско игрока]".
      // ИИ №27: базовый armyToAttack теперь ЭСКАЛИРОВАННЫЙ по времени партии
      // (escalatedArmyToAttack, см. её комментарий выше) — по прямому
      // запросу пользователя "затянутость битвы = круче армия". isDominant/
      // isOutmatched применяются К УЖЕ эскалированному числу, так же, как
      // раньше применялись к статичному ENEMY_ARMY_TO_ATTACK() — сама
      // эскалация не отменяет "дожимание"/"осторожность", а сдвигает базу,
      // от которой они считаются.
      const armyToAttack = escalatedArmyToAttack();
      let requiredArmy = armyToAttack;
      if (isDominant) {
        requiredArmy = Math.max(2, Math.round(armyToAttack * 0.5));
      } else if (isOutmatched) {
        requiredArmy = Math.min(ENEMY_MAX_ARMY_CAP(), Math.round(armyToAttack * 1.8));
      } else {
        requiredArmy = Math.min(ENEMY_MAX_ARMY_CAP(), armyToAttack);
      }
      // При явном превосходстве игрока не выходим по таймауту с недостаточной
      // армией (иначе "копить войска" превращалось бы в фикцию — ИИ всё
      // равно полез бы в лоб через ENEMY_PHASE_DURATIONS.BUILDUP секунд) —
      // продолжаем сидеть в BUILDUP, только СИЛЬНО удлиняя таймаут (x3), а не
      // ждём вечно (не хотим полного паралича ИИ, если игрок держит перевес
      // очень долго — рано или поздно ИИ должен хотя бы попытаться).
      const effectiveTimeout = isOutmatched ? durations.BUILDUP * 3 : durations.BUILDUP;
      const readyByTimer = enemyFsm.phaseTimer >= effectiveTimeout;
      // ИИ №27: БАГФИКС "ИИ нападает лёгкой пехотой и редкими танками"
      // (прямой запрос пользователя). Раньше единственным условием перехода
      // в ATTACK было ЧИСЛО боевых юнитов (combat.length >= requiredArmy) —
      // ИИ мог набрать требуемое число одной дешёвой пехотой и уйти в атаку,
      // даже имея построенные warFactory/airfield, просто не успев наштамповать
      // из них технику. Теперь ДОПОЛНИТЕЛЬНО (кроме isDominant — "дожимание"
      // важнее строгого состава, слабый игрок не должен получать передышку
      // только потому что у ИИ пока мало танков) требуем минимум "тяжёлых"
      // юнитов (tank/heavyTank/aircraft, см. countHeavyUnits/HEAVY_UNIT_TYPES
      // выше), растущий со временем партии (escalatedMinHeavyComposition).
      // readyByTimer по-прежнему может вытолкнуть ИИ в атаку даже без этого
      // состава — не хотим, чтобы ИИ застрял в BUILDUP НАВСЕГДА, если у него,
      // например, нет warFactory (турельный/пехотный расклад тоже должен
      // рано или поздно пойти в атаку, а не просидеть всю партию в обороне).
      const heavyCount = countHeavyUnits(combat);
      const requiredHeavy = isDominant ? 0 : escalatedMinHeavyComposition();
      const heavyReady = heavyCount >= requiredHeavy;
      if ((combat.length >= requiredArmy && heavyReady) || readyByTimer) {
        if (combat.length > 0) {
          enemyFsm.phase = "ATTACK"; enemyFsm.phaseTimer = 0;
          logMsg(isDominant ? "Противник чувствует слабость и переходит в наступление" : "Противник начинает атаку", "enemy");
        } else {
          enemyFsm.phaseTimer = 0; // ещё нечем атаковать — остаёмся в BUILDUP дольше
        }
      }
      break;
    }
    case "ATTACK": {
      enemyAttackStep();
      // Оцениваем "здоровье" армии как долю суммарного HP от суммарного maxHp —
      // если сильно просели, отступаем вместо того чтобы кормить игрока убийствами.
      let hp = 0, maxHp = 0;
      combat.forEach(u => { hp += u.hp; maxHp += u.maxHp; });
      const healthFrac = maxHp > 0 ? hp / maxHp : 0;
      // ИИ №25: порог отступления по HP тоже реагирует на pressure — если
      // ИИ явно доминирует (isDominant), готов драться при более низком %
      // HP, чем обычно (дожимает почти до конца, не сдаётся раньше времени
      // на слабом противнике). Если игрок явно сильнее (isOutmatched) —
      // отступает при более высоком % HP (бережёт остатки армии для
      // следующего накопления, а не разменивает её всю до последнего).
      const baseRetreatFrac = ENEMY_RETREAT_HP_FRACTION();
      let retreatFrac = baseRetreatFrac;
      if (isDominant) {
        retreatFrac = Math.max(0.08, baseRetreatFrac * 0.5);
      } else if (isOutmatched) {
        retreatFrac = Math.min(0.75, baseRetreatFrac * 1.6);
      }
      // Аналогично — доминирующий ИИ готов давить дольше отведённого
      // таймаута ATTACK (x1.5), не отступать только потому что "время
      // вышло", пока противник объективно слаб.
      const attackTimeout = isDominant ? durations.ATTACK * 1.5 : durations.ATTACK;
      if (combat.length === 0 || (maxHp > 0 && healthFrac < retreatFrac) || enemyFsm.phaseTimer >= attackTimeout) {
        enemyFsm.phase = "REGROUP"; enemyFsm.phaseTimer = 0;
        logMsg("Противник отступает и перегруппировывается", "enemy");
      }
      break;
    }
    case "REGROUP":
      enemyRegroupStep();
      if (enemyFsm.phaseTimer >= durations.REGROUP) {
        enemyFsm.phase = "BUILDUP"; enemyFsm.phaseTimer = 0;
      }
      break;
    default:
      enemyFsm.phase = "ECONOMY"; enemyFsm.phaseTimer = 0;
  }
}

