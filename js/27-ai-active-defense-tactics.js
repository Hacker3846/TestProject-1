/* ---------------------------- ИИ №49: активная защита живой силой ---------------------------- */
// Прямой запрос пользователя (дословно, часть 2 из 2, см. PROMPT_FOR_SECOND_AI.md):
// "надо чтобы ии был умнее, динамичнее вел бой... пусть не зашишается без
// причины, а когда зашишается пусть давит огнестрелами, а не трусит и
// ставит только стены". Предыдущая сессия (ИИ №48, 26-...js) закрыла
// ТОЛЬКО экономическую половину ("не защищается без причины" — рост
// стен/турелей/мортир/мин теперь заперт за enemyDefenseJustified()). Эта
// сессия (ИИ №49) закрывает ВТОРУЮ половину — "давит огнестрелами, когда
// есть повод": реальный отзыв боевых юнитов на защиту базы + отправка их
// НАВСТРЕЧУ захватчику, а не только пассивное "включиться, если враг уже
// оказался в 260px от юнита, который и так уже idle рядом со штабом".
//
// ДИАГНОЗ (по факту чтения 06-enemy-ai.js/07-game-loop-combat.js):
// enemyDefendBaseStep (06-...js) реагирует ТОЛЬКО на юнитов, у которых УЖЕ
// state==="idle" && !attackTargetId && !attackMoveMode, И которые УЖЕ
// физически в ENEMY_BASE_DEFEND_RADIUS(260px) от ШТАБА конкретно. Если вся
// боеспособная армия либо копится в BUILDUP/REGROUP у казармы (дальше
// 260px от hq), либо уже штурмует игрока в фазе ATTACK (state==="moving"
// или attackMoveMode на чужой территории) — под фильтр не попадает НИКТО,
// и реальная защита базы живой силой не происходит вообще, только
// турели/мины. Отсюда и жалоба "не умеет защищать базу, а то владеет
// только стенами".
//
// Архитектура (тот же приём "переопределение после объявления", что и весь
// проект, 13b-26) — НОВЫЙ файл, 06-enemy-ai.js НЕ редактируется:
//  1) enemyThreatenedBuildings() — своя, ДОПОЛНИТЕЛЬНАЯ функция поверх тех
//     же данных, что уже использует enemyBaseUnderActiveThreat (26-...js):
//     какие ИМЕННО существенные (не-стеновые) постройки ИИ прямо сейчас
//     находятся в радиусе вражеского боевого юнита. НЕ трогает и не
//     дублирует enemyBaseUnderActiveThreat/enemyDefenseJustified/
//     enemyThreatMemory — использует тот же ENEMY_THREAT_PROXIMITY_RADIUS
//     (26-...js), чтобы не рассинхронизироваться с экономической половиной
//     (см. её же комментарий: "не изобретай вторую, слегка другую
//     проверку 'есть ли угроза'" — эта функция не проверка "есть ли
//     угроза", это её ДЕТАЛИЗАЦИЯ до конкретных зданий, поверх готового ответа).
//  2) enemyActiveDefenseStep() — НОВАЯ функция, вызываемая КАЖДЫЙ
//     decision-тик (патчим updateEnemyStub так же, как 26-...js патчит
//     enemyWallStep/enemyMortarAndMineStep — "после оригинала"), которая:
//       a) при enemyDefenseJustified()===true (готовая функция 26-...js,
//          НЕ переопределяется) вычисляет пропорциональный ответ на силу
//          вторжения (estimateForceScore, готовая функция 06-...js) и
//          отзывает СТОЛЬКО боевых юнитов, сколько нужно, чтобы перекрыть
//          её force score, а не всех/никого;
//       b) берёт кандидатов на отзыв из ДВУХ источников: юниты в
//          attackMoveMode (ATTACK-фаза, штурмуют игрока) — отзываются те,
//          что физически БЛИЖЕ к дому, чем к их текущей attack-move цели;
//          и простаивающие юниты рядом с ЛЮБЫМ существенным зданием ИИ
//          (не только hq, в отличие от enemyDefendBaseStep) дальше 260px,
//          которые сейчас никуда не задействованы;
//       c) отозванным юнитам ставится attack-move НЕ на месте, а К
//          конкретной угрожаемой постройке (intercept) — приоритет живой
//          силы над пассивным "стоять и ждать за турелью".
//  3) enemyDefendBaseStep (06-...js, юниты УЖЕ рядом со штабом) НЕ
//     трогается и НЕ дублируется — она по-прежнему покрывает свой узкий
//     случай (мгновенная реакция на месте у hq), эта сессия ДОПОЛНЯЕТ её
//     более широким отзывом издалека, а не заменяет.
// Подключать ПОСЛЕДНИМ в index.html, ПОСЛЕ js/26-ai-defense-economy-throttle.js.

/* ==================================================================
   ЧАСТЬ 1: детализация угрозы до конкретных зданий (поверх готового
   enemyBaseUnderActiveThreat/ENEMY_THREAT_PROXIMITY_RADIUS, 26-...js)
   ================================================================== */

// Тот же радиус, что уже использует enemyBaseUnderActiveThreat (26-...js)
// — намеренно ЧИТАЕМ существующую константу, а не заводим свою копию
// числа, чтобы "какое именно здание под угрозой" всегда было согласовано
// с "есть ли угроза вообще" из экономической половины.
function enemyThreatenedBuildings() {
  const substantialBuildings = enemyBuildings().filter(b => b.type !== "wall");
  if (substantialBuildings.length === 0) return [];
  const invaders = playerCombatUnits();
  if (invaders.length === 0) return [];
  const threatened = [];
  for (const b of substantialBuildings) {
    for (const inv of invaders) {
      if (dist(b.x, b.y, inv.x, inv.y) <= ENEMY_THREAT_PROXIMITY_RADIUS) {
        threatened.push(b);
        break;
      }
    }
  }
  return threatened;
}

// Ближайшая угрожаемая постройка к точке (x,y) — используется, чтобы
// выбрать, КУДА именно направить отозванного юнита (intercept), а не
// просто "куда-то на базу". Если угрожаемых построек несколько —
// защищаем ближайшую к конкретному юниту, чтобы отозванная армия не вся
// скопом бежала в одну точку, если атаки идут с двух сторон базы сразу.
function enemyNearestThreatenedBuilding(threatened, x, y) {
  let best = null, bestD = Infinity;
  threatened.forEach(b => {
    const d = dist(x, y, b.x, b.y);
    if (d < bestD) { best = b; bestD = d; }
  });
  return best;
}

/* ==================================================================
   ЧАСТЬ 2: пропорциональный отзыв армии + intercept-диспетчеризация
   ================================================================== */

// Свой отдельный параметр (не переиспользуем ENEMY_BASE_DEFEND_RADIUS,
// т.к. это разные по духу пороги: тот — "юнит уже тут вплотную, просто
// включи автобой на месте", этот — "юнит вообще ещё где-то на территории
// своей базы, а не потерялся на другом краю карты" — используется как
// широкая рамка x3, а не точный радиус, см. idleStragglers ниже). Отдельно
// от ENEMY_THREAT_PROXIMITY_RADIUS(300, 26-...js) намеренно — та константа
// про "где враг", эта — про "где ещё свой простаивающий юнит считается
// частью базы, а не заблудившимся где-то в поле".
const ENEMY_IDLE_STRAGGLER_RADIUS = 260;

// Не отзываем совсем мелкие силы из ATTACK ради одного разведчика у забора
// (п.3 промпта: "не переусердствовать со стягиванием при мелких уколах") —
// нижний порог force score вторжения, ниже которого вообще не запускаем
// отзыв из активной атаки (простаивающих у зданий стягивать по-прежнему
// можно — они и так ничем не заняты, это не "отрывание от фронта").
const ENEMY_ATTACK_RECALL_MIN_INVADER_SCORE = 15;

function enemyActiveDefenseStep() {
  if (!enemyDefenseJustified()) return; // используем готовый критерий 26-...js как есть, без вариаций
  const threatened = enemyThreatenedBuildings();
  if (threatened.length === 0) return; // enemyDefenseJustified() мог сработать по памяти/pressure, а не по факту "враг сейчас у здания" — тогда intercept-адресату некуда идти

  const hq = enemyHq();
  const homeX = hq ? hq.x : (threatened[0].x);
  const homeY = hq ? hq.y : (threatened[0].y);

  const invaders = playerCombatUnits().filter(inv =>
    threatened.some(b => dist(b.x, b.y, inv.x, inv.y) <= ENEMY_THREAT_PROXIMITY_RADIUS)
  );
  const invaderScore = estimateForceScore(invaders);
  if (invaderScore <= 0) return;

  const combat = enemyUnits().filter(u => UnitDefs[u.type] && UnitDefs[u.type].canAttack);

  // Источник 1: юниты, уже дежурящие/бесцельно стоящие рядом с ЛЮБЫМ
  // существенным зданием ИИ (не только hq, в отличие от
  // enemyDefendBaseStep) — простаивающие БЕЗ приказа (idle, без цели, без
  // attack-move). Специально НЕ фильтруем по "дальше 260px от hq", как в
  // enemyDefendBaseStep — тот случай ("юнит и так уже в 260px от штаба и
  // рядом враг") уже покрыт ЕЙ, эта функция дополняет более широким
  // случаем: юнит простаивает у казармы/завода/другого здания ГДЕ УГОДНО
  // на базе и никуда не идёт, пока в другой части базы идёт вторжение —
  // "и так ничем не занят" делает отзыв бесплатным, отдельный радиус тут
  // не нужен (в отличие от attackingRecallable ниже, где мы намеренно НЕ
  // отзываем всех подряд из активного боя).
  const idleStragglers = combat.filter(u => {
    if (u.state !== "idle" || u.attackTargetId || u.attackMoveMode) return false;
    return enemyBuildings().some(b => b.type !== "wall" && dist(u.x, u.y, b.x, b.y) <= ENEMY_IDLE_STRAGGLER_RADIUS * 3);
  });

  // Источник 2: юниты в attack-move (штурмуют игрока, ATTACK-фаза),
  // которые СЕЙЧАС физически ближе к дому (штабу ИИ), чем к своей текущей
  // attack-move цели — простая эвристика дистанции из п.1 промпта, не
  // забираем всю армию с фронта, только тех, кому и так по пути ближе назад.
  const attackingRecallable = combat.filter(u => {
    if (!u.attackMoveMode) return false;
    const goalX = u.attackMoveHomeX != null ? u.attackMoveHomeX : u.x;
    const goalY = u.attackMoveHomeY != null ? u.attackMoveHomeY : u.y;
    const dHome = dist(u.x, u.y, homeX, homeY);
    const dGoal = dist(u.x, u.y, goalX, goalY);
    return dHome < dGoal;
  });

  // Что уже "дома" и в бою — не нужно отзывать повторно, вычитаем из требуемого ответа.
  const alreadyDefending = combat.filter(u =>
    u.attackMoveMode && u.attackMoveHomeX != null &&
    threatened.some(b => dist(u.attackMoveHomeX, u.attackMoveHomeY, b.x, b.y) <= ENEMY_THREAT_PROXIMITY_RADIUS)
  );
  const alreadyScore = estimateForceScore(alreadyDefending);
  let remainingNeed = invaderScore - alreadyScore;
  if (remainingNeed <= 0) return; // уже отправлено достаточно сил на прошлых тиках, не дублируем приказ

  // Дёшево -> дорого: сперва простаивающих (они и так ничем не заняты, их
  // отзыв не стоит "недоведённой атаки"), только потом, и то не всегда —
  // из штурмующей армии.
  const recallPool = idleStragglers.slice();

  const invaderScoreGateForAttackPull = ENEMY_ATTACK_RECALL_MIN_INVADER_SCORE;
  if (invaderScore >= invaderScoreGateForAttackPull) {
    // Сортируем по убыванию "долга" (насколько юнит ближе к дому, чем к
    // цели) не нужно — берём в порядке появления, штурмующих и так обычно
    // немного за раз (decision-тик достаточно частый), простая эвристика
    // не требует точной сортировки для разумного результата.
    attackingRecallable.forEach(u => recallPool.push(u));
  }

  if (recallPool.length === 0) return;

  let coveredScore = 0;
  for (const u of recallPool) {
    if (coveredScore >= remainingNeed) break;
    const target = enemyNearestThreatenedBuilding(threatened, u.x, u.y) || threatened[0];
    // ИИ №24 контракт (07-game-loop-combat.js, CHASE_LEASH_RADIUS): явно
    // переприсваиваем attackMoveHomeX/Y на НОВУЮ точку у себя на базе —
    // иначе леш будет мерить дистанцию от старой (чужой) домашней точки
    // ATTACK-фазы и почти сразу прервёт только что отданный приказ.
    // БАГФИКС (найдено при повторной проверке этой сессии): юнит, отзываемый
    // из ATTACK, мог быть в этот момент УЖЕ вовлечён в бой (attackTargetId
    // указывает на живую цель, которую он встретил по дороге, см. ИИ №40/
    // ATTACK_MOVE_AGGRO_BONUS, 07-game-loop-combat.js). updateCombat каждый
    // тик СНАЧАЛА проверяет именно attackTargetId (приоритет №1, раньше
    // автопоиска/леша) — если его не сбросить явно здесь, юнит продолжает
    // стоять и добивать старую цель НА МЕСТЕ, полностью игнорируя новый
    // attackMoveHomeX/Y и setUnitDestination ниже, пока старая цель не
    // умрёт или не выйдет из радиуса атаки. Сбрасываем attackTargetId —
    // тот же путь, которым это делает сам "поводок" в updateCombat (см. её
    // ветку CHASE_LEASH_RADIUS выше по файлу) — юнит подхватит НОВУЮ цель
    // автопоиском уже по дороге к threatened building (attackMoveMode
    // остаётся true, автопоиск и так продолжает работать).
    u.attackTargetId = null;
    u.attackMoveMode = true;
    setUnitDestination(u, target.x, target.y);
    u.attackMoveHomeX = target.x;
    u.attackMoveHomeY = target.y;
    u.state = "moving";
    // Переиспользуем estimateForceScore (06-...js) на одиночном юните, а
    // не дублируем её формулу вручную — тот же принцип "не изобретать
    // вторую версию готовой оценки силы", что и во всём остальном файле.
    coveredScore += estimateForceScore([u]);
  }
}

(function patchUpdateEnemyStubForActiveDefense() {
  if (typeof updateEnemyStub !== "function") return;
  const _updateEnemyStubReal = updateEnemyStub;
  updateEnemyStub = function (dt) {
    const result = _updateEnemyStubReal(dt);
    // Вызывается ПОСЛЕ оригинала, но всё ещё внутри decision-тика
    // (updateEnemyStub сам троттлит через decisionTimer/ENEMY_DECISION_INTERVAL
    // и рано выходит, если тик "пустой" — enemyActiveDefenseStep тогда тоже
    // не позовётся в этот вызов, что и нужно: не имеет смысла принимать
    // тактические решения о живой силе чаще, чем сам ИИ вообще "думает").
    // КАЖДЫЙ decision-тик, независимо от фазы enemyFsm — тот же принцип,
    // что уже применяет enemyDefendBaseStep (06-...js), не ждём своей
    // очереди в switch.
    if (enemyFsm.decisionTimer === 0) {
      // decisionTimer обнуляется оригиналом ТОЛЬКО когда decision-тик
      // реально произошёл в этом вызове (см. updateEnemyStub, 06-...js:
      // "if (decisionTimer < INTERVAL) return;" до обнуления) — если тик
      // был пропущен (троттлинг), decisionTimer > 0 и мы сюда не заходим.
      enemyActiveDefenseStep();
    }
    return result;
  };
})();

/* ---------------------------- ОТКРЫТО / НЕ СДЕЛАНО (следующему ИИ) ----------------------------
   Эта сессия (ИИ №49) закрыла тактическую половину запроса пользователя:
   реальный пропорциональный отзыв живой силы (из простоя у любого здания
   ИИ и, при достаточно серьёзном вторжении, частично из штурмующей
   ATTACK-армии) + intercept-диспетчеризация к конкретной угрожаемой
   постройке, вместо пассивного "включиться на месте, если враг уже в
   260px от штаба".

   НЕ СДЕЛАНО (мельче, не было явно в приоритете промпта, но замечено при
   реализации):
    - idleStragglers сейчас просто "простаивает и в пределах x3 от
      ENEMY_IDLE_STRAGGLER_RADIUS от какого-то не-стенового здания" — не
      различает "стоит у казармы посреди своей базы" от "потерялся у
      дальнего угла периметра, но формально ещё в рамке". На практике не
      страшно (отозвать такого юнита — не потеря, он и так ничем не
      занят), но следующий ИИ может уточнить геометрию, если понадобится.
    - Нет приоритезации ТИПА юнита при отзыве (например, сначала
      танки/тяжёлая техника, потом пехота) — сейчас порядок отзыва это
      порядок появления в enemyUnits()/Object.values, что достаточно для
      "давит огнестрелами" (живая сила вместо пассивного ожидания), но не
      гарантирует "лучший" состав интерцепторов.
    - alreadyDefending считает юнита "уже защищающим" по совпадению
      attackMoveHomeX/Y с радиусом угрожаемого здания — если угроза
      сместилась к ДРУГОМУ зданию базы между тиками, старый интерцептор
      может не переприказаться на новую точку, пока не освободится
      (target==null) естественным образom. Не критично (второй виток
      отзыва всё равно подберёт разницу через remainingNeed), но не
      идеально мгновенно.
   Использовать enemyThreatenedBuildings/enemyNearestThreatenedBuilding
   (эта сессия, выше в этом файле) как готовый строительный блок для
   геометрии угрозы по конкретным зданиям — не дублировать вторую версию. */