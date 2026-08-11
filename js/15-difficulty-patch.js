/* ---------------------------- ИИ №28: патч темпа партии ---------------------------- */
// Прямой запрос пользователя: "ИИ слишком лёгкий/слишком часто атакует,
// войска падают быстро, битва (вся партия) длится 5-10 минут, надо 25-40;
// отдельно — ИИ атакует примерно раз в 1-2 минуты, хочу чтобы копил
// заметно дольше (ориентир: лёгкий ~2 мин на цикл накопления, нормальный
// и сложный ~5 мин), плюс замедлить шаг юнитов (~40%) для более плавной и
// медленной анимации передвижения; сложный дополнительно получает
// экономическое преимущество (доход/скорость производства), а не только
// короче цикл".
//
// Сделано ОТДЕЛЬНЫМ файлом (js/15-difficulty-patch.js), а не правкой
// EnemyDifficultyProfiles/UnitDefs напрямую в 01-config-state.js — так
// проще откатить одним удалением <script> из game.html, и патч виден
// как единый диф без размазывания по оригинальным файлам. Подключать
// В game.html ПОСЛЕ 01-config-state.js и 06-enemy-ai.js, ДО
// 13-bootstrap.js (init() дергает initEnemyStub/initLocalPlayer, которые
// читают эти таблицы уже читая изменённые значения):
//   <script src="js/01-config-state.js"></script>
//   ...
//   <script src="js/06-enemy-ai.js"></script>
//   ...
//   <script src="js/14-game-end.js"></script>
//   <script src="js/15-difficulty-patch.js"></script>   <!-- новая строка -->
//   <script src="js/13-bootstrap.js"></script>
// (порядок 13/14 как в исходном game.html — просто вставить новую строку
// ПЕРЕД 13-bootstrap.js, где бы он ни стоял).
//
// НЕ переопределяет функции 06-enemy-ai.js — все ENEMY_*() уже читают
// EnemyDifficultyProfiles[...] заново при каждом вызове (см. комментарий
// ИИ №26 в 06-enemy-ai.js про "ленивое" чтение), поэтому достаточно
// просто ПОМЕНЯТЬ значения в самой таблице ДО того, как partия
// стартует — никакого патчинга функций не нужно.

/* -------- 1) Скорость юнитов: -40% (запрос пользователя) -------- */
// Единый множитель, применяется ко ВСЕМ типам разом — соотношения
// скоростей между юнитами (rifleman быстрее tank и т.п.) сохраняются,
// падает только абсолютное значение. aircraft тоже замедляется тем же
// множителем (не исключение из правила — пользователь просил замедлить
// "у всех юнитов").
const UNIT_SPEED_MULTIPLIER = 0.6; // было 1.0 => на 40% медленнее
Object.keys(UnitDefs).forEach(key => {
  const def = UnitDefs[key];
  if (typeof def.speed === "number") {
    def.speed = def.speed * UNIT_SPEED_MULTIPLIER;
  }
});

/* -------- 2) Темп партии: длиннее циклы ECONOMY/BUILDUP -------- */
// Раньше (см. 06-enemy-ai.js, ENEMY_PHASE_DURATIONS_BASE):
//   ECONOMY 15с + BUILDUP 20с + ATTACK(макс) 30с + REGROUP 10с = 75с/цикл
// на normal (mult=1.0), быстрее на hard (mult=0.7 => ~52.5с/цикл) — отсюда
// и "атакует каждую минуту-две". Плюс readyByTimer часто выталкивал ИИ в
// атаку ещё раньше срока, как только набегало ENEMY_ARMY_TO_ATTACK бойцов.
//
// Цель пользователя (его же формулировка, не жёсткая привязка ко
// времени, а ориентир): easy копит ~2 мин, normal/hard ~5 мин перед тем
// как впервые сможет пойти в атаку; вся партия — 25-40 минут.
//
// Меняю ECONOMY/BUILDUP (фаза накопления) напрямую в секундах под каждый
// уровень, а не просто through phaseDurationMultiplier — множитель бы
// растянул ATTACK/REGROUP пропорционально тоже, а бой должен остаться
// динамичным (не тянуть сам бой на 5 минут, только накопление ДО него).
// ATTACK/REGROUP растянуты значительно скромнее — бой сам по себе не
// должен стать вялым, только реже случаться.
EnemyDifficultyProfiles.easy.phaseDurationMultiplier = 1.0; // используем ECONOMY_SEC/BUILDUP_SEC ниже напрямую, множитель фаз больше не отвечает за темп
EnemyDifficultyProfiles.normal.phaseDurationMultiplier = 1.0;
EnemyDifficultyProfiles.hard.phaseDurationMultiplier = 1.0;

// Новые целевые длительности накопления (ECONOMY+BUILDUP), в мс:
//  easy   ~ 2 мин  =>  ECONOMY 45с + BUILDUP 75с  = 120с
//  normal ~ 5 мин  =>  ECONOMY 90с + BUILDUP 210с = 300с
//  hard   ~ 5 мин  =>  ECONOMY 80с + BUILDUP 220с = 300с (чуть короче
//    ECONOMY — экономический бонус ниже уже даёт hard фору по темпу
//    найма рабочих/зданий, не нужно ЕЩЁ и здесь удлинять)
// ATTACK/REGROUP растянуты умеренно (не в 4 раза, как накопление) — сам
// бой должен остаться динамичным, только более редким.
const ENEMY_PACING_OVERRIDE = {
  easy:   { ECONOMY: 45000,  BUILDUP: 75000,  ATTACK: 26000, REGROUP: 14000 },
  normal: { ECONOMY: 90000,  BUILDUP: 210000, ATTACK: 34000, REGROUP: 20000 },
  hard:   { ECONOMY: 80000,  BUILDUP: 220000, ATTACK: 40000, REGROUP: 18000 },
};
// ENEMY_PHASE_DURATIONS_BASE (06-enemy-ai.js) — const верхнего уровня,
// но объект МУТИРУЕМ (не переприсваиваем переменную), поэтому это
// работает несмотря на const: currentPhaseDurations() (06) читает поля
// этого объекта заново на каждый вызов, значения ниже подставятся сразу.
// ВАЖНО: сложность выбирается ОДНА на партию (SelectedEnemyProfile.difficulty,
// экран выбора 10b), а ENEMY_PHASE_DURATIONS_BASE — общий объект без
// разбивки по сложности. Поэтому синхронизируем его с профилем игрока
// прямо перед стартом (после экрана выбора, до init()) — см. блок hook
// ниже, а не жёстко один раз здесь на "normal" по умолчанию.
function applyEnemyPacingForCurrentDifficulty() {
  const key = (typeof SelectedEnemyProfile !== "undefined" && SelectedEnemyProfile.difficulty) || "normal";
  const pacing = ENEMY_PACING_OVERRIDE[key] || ENEMY_PACING_OVERRIDE.normal;
  ENEMY_PHASE_DURATIONS_BASE.ECONOMY = pacing.ECONOMY;
  ENEMY_PHASE_DURATIONS_BASE.BUILDUP = pacing.BUILDUP;
  ENEMY_PHASE_DURATIONS_BASE.ATTACK = pacing.ATTACK;
  ENEMY_PHASE_DURATIONS_BASE.REGROUP = pacing.REGROUP;
}
// Применяем сразу с дефолтом ("normal"), на случай если экран выбора (10b)
// отсутствует и initEnemyStub() вызовется раньше, чем пользователь
// сделает выбор — тот же принцип "безопасный дефолт", что и в остальном
// проекте (см. SelectedEnemyProfile в 01-config-state.js).
applyEnemyPacingForCurrentDifficulty();
// И перепривязываем к моменту реального выбора сложности — оборачиваем
// setupEnemySelectScreen(onConfirm) НЕ трогаем (10b), вместо этого вешаем
// патч на сам onConfirm через обёртку initEnemyStub(): она вызывается
// РОВНО ОДИН РАЗ из bootstrap (13) уже ПОСЛЕ того, как экран выбора (10b)
// записал финальный SelectedEnemyProfile.difficulty — самая надёжная
// точка, не зависящая от того, есть экран выбора или нет.
const _originalInitEnemyStub = initEnemyStub;
initEnemyStub = function patchedInitEnemyStub() {
  applyEnemyPacingForCurrentDifficulty();
  return _originalInitEnemyStub.apply(this, arguments);
};

/* -------- 3) ЧИТ: прямой буст дохода и скорости производства ИИ -------- */
// Прямой запрос пользователя: "давай ИИ будет читерить" + "подкрутить %
// их дохода и повысить скорость их создания, сделай переменные, которые
// можно менять в коде" (уточнено явно: скорость постройки/найма должна
// стать БЫСТРЕЕ, не медленнее). Это НЕ честная механика (в отличие от
// блока workerTarget выше) — ИИ получает БОЛЬШЕ денег и БЫСТРЕЕ строит
// юнитов, чем ему реально "заработано" харвестом/очередью.
//
// Все параметры вынесены в объект ниже — меняй числа тут, ничего
// больше в файле трогать не нужно. 1.0 = без чита (как у игрока),
// >1.0 = буст в пользу ИИ. Ключи — "easy"/"normal"/"hard", значения —
// множители.
const AI_CHEAT_SETTINGS = {
  // incomeMultiplier: во сколько раз больше кредитов ИИ получает при
  // каждой сдаче груза рабочим на базу (см. "returning" -> зачисление
  // в gameTick, 07-game-loop-combat.js). 1.5 = на 50% больше денег за
  // тот же самый рейс рабочего туда-обратно.
  // productionSpeedMultiplier: во сколько раз БЫСТРЕЕ идёт очередь
  // постройки/найма зданий ИИ (buildQueue[0].msLeft тает быстрее, см.
  // updateProductionQueues, 07-game-loop-combat.js). 1.5 = здания и
  // юниты у ИИ выходят из очереди в 1.5 раза быстрее при тех же msLeft.
  easy:   { incomeMultiplier: 1.0, productionSpeedMultiplier: 1.0 }, // easy — без чита вообще, как раньше
  normal: { incomeMultiplier: 1.5, productionSpeedMultiplier: 1.4 }, // лёгкий чит, почти незаметно
  hard:   { incomeMultiplier: 1.9, productionSpeedMultiplier: 1.7 },  // заметный чит — hard должен ощущаться нечестно сильным
};
function currentAiCheatSettings() {
  const key = (typeof SelectedEnemyProfile !== "undefined" && SelectedEnemyProfile.difficulty) || "normal";
  return AI_CHEAT_SETTINGS[key] || AI_CHEAT_SETTINGS.normal;
}

// --- Доход: домножаем прирост credits ИИ ПОСЛЕ каждого gameTick ---
// Не трогаем сам харвест-код (node.amount -= amt, 07) — вместо этого
// сравниваем credits ИИ ДО и ПОСЛЕ оригинального gameTick. Единственный
// путь, которым credits ИИ растут в течение партии — зачисление при
// сдаче груза рабочим (см. блок "returning" в gameTick) — build/queue
// только ТРАТЯТ credits, никогда не увеличивают. Поэтому любой
// положительный прирост здесь — это честно заработанный доход, который
// можно безопасно домножить постфактум, не залезая в саму формулу
// зачисления внутри 07-game-loop-combat.js.
const _originalGameTick = gameTick;
gameTick = function patchedGameTick(dtMs) {
  const player = State.players[enemyPlayerId];
  const before = player ? player.credits : 0;
  const result = _originalGameTick.call(this, dtMs);
  if (player) {
    const delta = player.credits - before;
    if (delta > 0) {
      const mult = currentAiCheatSettings().incomeMultiplier;
      if (mult !== 1.0) {
        player.credits += delta * (mult - 1); // добавляем ТОЛЬКО разницу сверх честно заработанного
      }
    }
  }
  return result;
};

// --- Скорость производства: досрочно "доедаем" msLeft очереди ИИ ---
// Аналогично — не трогаем updateProductionQueues (07) напрямую, а
// оборачиваем: даём оригиналу отработать честно (dtMs), затем для ЧУЖИХ
// (принадлежащих enemyPlayerId) заказов в очереди дополнительно вычитаем
// (mult-1)*dtMs*rate сверху — итоговый эффект идентичен тому, как если
// бы у ИИ было mult раз больше "прошедшего времени" на эту очередь.
// Действует ТОЛЬКО на здания владельца enemyPlayerId — очередь игрока
// (localPlayerId) эта обёртка не трогает вообще.
const _originalUpdateProductionQueues = updateProductionQueues;
updateProductionQueues = function patchedUpdateProductionQueues(dtMs) {
  const mult = currentAiCheatSettings().productionSpeedMultiplier;
  const result = _originalUpdateProductionQueues.call(this, dtMs);
  if (mult !== 1.0) {
    Object.values(State.buildings).forEach(b => {
      if (b.ownerId !== enemyPlayerId) return;
      if (!b.buildQueue || b.buildQueue.length === 0) return;
      const order = b.buildQueue[0];
      // powerRateMultiplier учтён внутри оригинала уже один раз — здесь
      // просто досрочно "доедаем" оставшееся время пропорционально
      // (mult-1), тем же грубым приближением rate=1 (чит не обязан быть
      // идеально честен к дефициту питания — это и есть смысл чита).
      order.msLeft -= dtMs * (mult - 1);
      // updateProductionQueues уже могла заспавнить юнита и сдвинуть
      // очередь в оригинальном вызове выше — если msLeft после нашей
      // добавки ушёл в минус у СЛЕДУЮЩЕГО заказа (b.buildQueue[0]
      // мог смениться), просто позволяем ему "доехать" естественно на
      // следующем тике — не спавним юнита здесь повторно, чтобы не
      // дублировать логику спавна (id/rally/random-разброс) из 07.
    });
  }
  return result;
};

/* -------- 3b) Старый экономический бонус hard — оставлен выключенным -------- */
// ИИ №28 раньше (до появления доступа к 07-game-loop-combat.js) давал
// hard фиксированную добавку +80 кредитов раз в 20с как обходной путь.
// Теперь это заменено честным "во сколько раз" множителем выше
// (incomeMultiplier), который масштабируется вместе с реальным доходом
// вместо фиксированной надбавки — оставляю переменные закомментированными
// на случай отката, не удаляю совсем.
// const HARD_ECONOMY_BONUS_INTERVAL_MS = 20000;
// const HARD_ECONOMY_BONUS_CREDITS = 80;

/* -------- 4) Сложный: решения ощутимо чаще (скорость реакции) -------- */
// decisionInterval у hard и так был самым низким (800мс, см.
// EnemyDifficultyProfiles.hard в 01-config-state.js) — оставляю как есть,
// это уже даёт hard "производственное" преимущество (чаще проверяет
// очереди/атакует новыми юнитами первым) без дополнительных правок.

/* -------- 5) Честная экономика: больше рабочих на всех уровнях -------- */
// Прямой запрос пользователя: "хочу больше войска за то же время, но
// честно — через рабочих/добычу, не через читы". workerTarget — сколько
// рабочих ИИ пытается держать одновременно (enemyEconomyStep нанимает
// новых, пока workerCount < workerTarget, см. 06-enemy-ai.js). Больше
// рабочих = больше параллельного харвеста (каждый добывает независимо от
// остальных, см. enemyAssignHarvesters/gameTick) = выше суммарный доход
// в единицу времени — это НЕ читерский бонус к деньгам, а честный рост
// экономики через постройку. Применяется КО ВСЕМ трём уровням, каждый
// чуть сильнее прежнего (не только hard — по прямому запросу пользователя
// "все три, каждый чуть сильнее чем сейчас"). Дельты подобраны
// пропорционально прежним значениям, чтобы относительная разница
// easy/normal/hard сохранилась (лёгкий всё ещё заметно слабее сложного).
EnemyDifficultyProfiles.easy.workerTarget += 2;    // было 3 => 5
EnemyDifficultyProfiles.normal.workerTarget += 3;  // было 4 => 7
EnemyDifficultyProfiles.hard.workerTarget += 5;    // было 9 => 14

// У ИИ всего 5 фиксированных ресурсных нод рядом со стартом (см.
// seedEnemyResourceNode, 06-enemy-ai.js), по 4000 каждая = 20000 суммарно.
// При выросшем workerTarget (особенно hard: 14 рабочих) это по-прежнему
// не кончится за партию 25-40 минут при честном темпе добычи (1/тик на
// рабочего), поэтому amount НЕ трогаю — увеличивать его смысла нет, узким
// местом остаётся не "закончатся ресурсы", а физическая скученность
// рабочих у одной точки (вопрос applyUnitSeparation в 07, не экономики).
// Если после игры покажется, что рабочие всё же толкутся и простаивают —
// возможное решение: увеличить число точек в spots (seedEnemyResourceNode)
// или радиус, на котором они расставлены, но это уже вопрос geometрии
// карты, не сложности, поэтому не трогаю здесь без явного запроса.
