/* ---------------------------- Экран выбора противника ---------------------------- */
// ИИ №8: новый модуль, а не правка js/10-hud.js напрямую — файл 10-hud.js
// не был среди присланных мне файлов (см. PROMPT_FOR_NEXT_AI.md, раздел 0:
// "каждый ИИ видит только те файлы, которые ему прислали"), поэтому
// безопаснее добавить отдельный модуль, чем вслепую редактировать код,
// которого я не вижу, и рисковать конфликтом имён/структуры. Следующий ИИ
// может перенести эту логику внутрь 10-hud.js, если сочтёт нужным — оба
// файла отвечают за HUD/UI, разделение между ними сейчас чисто
// организационное.
//
// Что делает модуль: показывает оверлей #enemySelectScreen (разметка в
// game.html) с выбором сложности (EnemyDifficultyProfiles) и фракции
// (EnemyFactionProfiles) из js/01-config-state.js, по кнопке "Начать бой"
// сохраняет выбор в SelectedEnemyProfile и вызывает переданный колбэк
// (см. js/13-bootstrap.js, startGameAfterSelection()).
//
// Порядок подключения: должен идти ПОСЛЕ js/01-config-state.js (нужны
// EnemyDifficultyProfiles/EnemyFactionProfiles/SelectedEnemyProfile) и
// ДО js/13-bootstrap.js (который вызывает setupEnemySelectScreen()).

function setupEnemySelectScreen(onConfirm) {
  const screen = document.getElementById("enemySelectScreen");
  if (!screen) {
    // Разметки оверлея нет в game.html — не блокируем игру молча, просто
    // стартуем как раньше с дефолтным профилем (normal/crimson).
    onConfirm();
    return;
  }

  let chosenDifficulty = SelectedEnemyProfile.difficulty;
  let chosenFaction = SelectedEnemyProfile.faction;

  const diffContainer = document.getElementById("enemyDifficultyOptions");
  const factionContainer = document.getElementById("enemyFactionOptions");
  const startBtn = document.getElementById("enemySelectStartBtn");

  function renderOptions(container, defs, chosenKey, onPick) {
    if (!container) return;
    container.innerHTML = "";
    Object.keys(defs).forEach(key => {
      const def = defs[key];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "enemySelectOptBtn" + (key === chosenKey ? " selected" : "");
      btn.textContent = def.label;
      btn.dataset.key = key;
      btn.addEventListener("click", () => {
        onPick(key);
        Array.from(container.children).forEach(c => c.classList.toggle("selected", c.dataset.key === key));
      });
      container.appendChild(btn);
    });
  }

  renderOptions(diffContainer, EnemyDifficultyProfiles, chosenDifficulty, (key) => { chosenDifficulty = key; });
  renderOptions(factionContainer, EnemyFactionProfiles, chosenFaction, (key) => { chosenFaction = key; });

  function confirmSelection() {
    SelectedEnemyProfile.difficulty = chosenDifficulty;
    SelectedEnemyProfile.faction = chosenFaction;
    screen.style.display = "none";
    const enemyLabelEl = document.getElementById("enemyLabel");
    if (enemyLabelEl) {
      const diffLabel = (EnemyDifficultyProfiles[chosenDifficulty] || {}).label || chosenDifficulty;
      const factionLabel = (EnemyFactionProfiles[chosenFaction] || {}).label || chosenFaction;
      enemyLabelEl.textContent = `${factionLabel} (${diffLabel})`;
    }
    onConfirm();
  }

  if (startBtn) {
    startBtn.addEventListener("click", confirmSelection);
  } else {
    // Кнопки почему-то нет в разметке — не оставляем игрока перед вечно
    // висящим оверлеем без выхода.
    confirmSelection();
  }
}
