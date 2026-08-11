/* ---------------------------- Экран победы/поражения (ИИ №25, редизайн ИИ №30) ---------------------------- */
// Задача пользователя (ИИ №25): "добавь экран победы и проигрыша, хватит
// и просто надписи победил-проиграл и кнопки вернуться на главную".
// Задача пользователя (ИИ №30/этот проход): "сделай крутой интерфейс,
// экран пригрыша [победы/проигрыша]" — экран остаётся тем же по СМЫСЛУ
// условия окончания игры (см. sideAlive ниже, не менялось), но теперь
// показывает разбор боя (BattleStats, см. 13b-battle-stats.js) вместо
// голой надписи, с раздельным оформлением победы/поражения.
//
// Условие конца игры не менялось: сторона считается уничтоженной, когда
// у неё не осталось НИ ОДНОГО живого юнита И НИ ОДНОГО здания (см.
// исходное обоснование ниже, сохранено от ИИ №25):
// рабочий без штаба всё ещё "жив" и в принципе может отбиться/выжить, а
// игрок с юнитами, но без единого здания (последний завод только что
// снесли), ещё не обязательно проиграл прямо в этот тик. Полное
// отсутствие и юнитов, и построек — однозначный и стандартный для RTS
// критерий поражения, не даёт ложных срабатываний.
//
// Реализация: тот же приём, что и раньше — оборачиваем gameTick
// (переопределение ПОСЛЕ объявления, без правки 07-game-loop-combat.js),
// после каждого вызова проверяем обе стороны, раз в тик.
(function setupGameEndScreen() {
  const screenEl = document.getElementById("gameEndScreen");
  const titleEl = document.getElementById("gameEndTitle");
  const subEl = document.getElementById("gameEndSub");
  const homeBtn = document.getElementById("gameEndHomeBtn");
  if (!screenEl || !titleEl || !homeBtn) return; // разметка почему-то отсутствует — не мешаем остальной игре

  let ended = false; // как только исход показан — больше не проверяем и не показываем повторно

  function sideAlive(ownerId) {
    for (const u of Object.values(State.units)) {
      if (u.ownerId === ownerId && u.hp > 0) return true;
    }
    for (const b of Object.values(State.buildings)) {
      if (b.ownerId === ownerId && b.hp > 0) return true;
    }
    return false;
  }

  // ИИ №30: карточка одной метрики в разборе боя — маленький повторяемый
  // строительный блок, чтобы не дублировать разметку 6 раз подряд.
  function statCard(icon, label, value, tone) {
    return `<div class="endStatCard${tone ? " " + tone : ""}">
        <span class="endStatIcon">${icon}</span>
        <span class="endStatValue">${value}</span>
        <span class="endStatLabel">${label}</span>
      </div>`;
  }

  function buildStatsHtml() {
    const elapsed = typeof battleStatsElapsedMs === "function" ? battleStatsElapsedMs() : 0;
    const duration = typeof formatDurationShort === "function" ? formatDurationShort(elapsed) : "—";
    const stats = (typeof BattleStats !== "undefined") ? BattleStats : {
      playerUnitsLost: 0, playerBuildingsLost: 0, enemyUnitsLost: 0, enemyBuildingsLost: 0, peakCredits: 0,
    };
    return `
      <div class="endStatsGrid">
        ${statCard("⏱", "Длительность боя", duration)}
        ${statCard("💰", "Пик экономики", Math.floor(stats.peakCredits) + " кр.")}
        ${statCard("💀", "Ваши потери", stats.playerUnitsLost + stats.playerBuildingsLost, "endStatBad")}
        ${statCard("⚔", "Уничтожено врагов", stats.enemyUnitsLost + stats.enemyBuildingsLost, "endStatGood")}
      </div>`;
  }

  function showEndScreen(victory) {
    ended = true;
    titleEl.textContent = victory ? "Победа" : "Поражение";
    titleEl.className = victory ? "victory" : "defeat";
    subEl.textContent = victory
      ? "Вражеская база уничтожена. Операция выполнена."
      : "Ваша база уничтожена. Операция провалена.";

    const panel = document.getElementById("gameEndPanel");
    panel.classList.toggle("victoryPanel", victory);
    panel.classList.toggle("defeatPanel", !victory);

    const emblemEl = document.getElementById("gameEndEmblem");
    if (emblemEl) emblemEl.textContent = victory ? "⚑" : "☠";

    // Разбор боя вставляется ПЕРЕД кнопкой "на главную", если такого блока
    // ещё нет в разметке (idempotent — на случай, если showEndScreen как-то
    // вызовется дважды до перезагрузки страницы).
    let statsEl = document.getElementById("gameEndStats");
    if (!statsEl) {
      statsEl = document.createElement("div");
      statsEl.id = "gameEndStats";
      homeBtn.parentNode.insertBefore(statsEl, homeBtn);
    }
    statsEl.innerHTML = buildStatsHtml();

    screenEl.classList.add("show");
  }

  homeBtn.addEventListener("click", function () {
    // "Главная" в этом прототипе — экран выбора сложности/фракции перед
    // стартом (enemySelectScreen в game.html). Простая перезагрузка страницы
    // возвращает ровно туда же путём, каким приложение и так стартует
    // (js/13-bootstrap.js показывает enemySelectScreen на чистой загрузке) —
    // не нужно отдельно откатывать State/останавливать gameTick вручную.
    location.reload();
  });

  // ИИ №34: БАГФИКС — "заходишь в PvP и сразу победа, даже соперника не
  // ждёт" (прямой репорт пользователя). Причина: этот файл написан ИИ
  // №25/№30 ДО появления PvP (js/18-pvp-multiplayer.js) и ничего не знает
  // про MultiplayerMode — старая проверка `sideAlive(enemyPlayerId)`
  // читает юниты/здания стороны "enemy_ai" (константа бота, см.
  // 06-enemy-ai.js). В PvP-партии updateEnemyStub/initEnemyStub вообще НЕ
  // вызываются (см. комментарий в 18-pvp-multiplayer.js) — State.players
  // не содержит "enemy_ai", у него никогда не будет ни юнитов, ни зданий.
  // sideAlive("enemy_ai") возвращает false С ПЕРВОГО ТИКА, ещё ДО того,
  // как второй игрок вообще подключился к комнате — отсюда мгновенная
  // "победа" по факту простого старта партии.
  //
  // Фикс: в PvP проверяем живость РЕАЛЬНОГО соперника
  // (MultiplayerMode.opponentId, заполняется в 18-pvp-multiplayer.js при
  // первом обнаружении второго игрока в комнате), а не enemyPlayerId.
  // Пока opponentId ещё не известен (соперник не подключился/не прислал
  // ни одного снапшота) — вражеская сторона просто НЕ проверяется вовсе:
  // рано делать вывод "враг уничтожен", когда врага в State ещё физически
  // нет, это не тот же случай, что "враг был и его снесли". В режиме "ai"
  // (обычная игра против бота) поведение не меняется ни на строку —
  // проверяем enemyPlayerId, как и раньше.
  function currentEnemySideId() {
    if (typeof MultiplayerMode !== "undefined" && MultiplayerMode.mode === "pvp") {
      return MultiplayerMode.opponentId; // может быть null — соперник ещё не найден
    }
    return enemyPlayerId;
  }

  const _gameTick = gameTick;
  gameTick = function (dtMs) {
    const result = _gameTick(dtMs);
    if (!ended) {
      const playerAlive = sideAlive(localPlayerId);
      if (!playerAlive) {
        showEndScreen(false);
      } else {
        const enemySideId = currentEnemySideId();
        // enemySideId===null => PvP, соперник ещё не подключился/не
        // синхронизировался ни разу — не проверяем эту сторону, ждём.
        if (enemySideId != null) {
          const enemyAlive = sideAlive(enemySideId);
          if (!enemyAlive) showEndScreen(true);
        }
      }
    }
    return result;
  };
})();
