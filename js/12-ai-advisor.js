/* ---------------------------- Настройки ИИ (чтение из localStorage) ---------------------------- */
// settings.html пишет конфиг под ключом "generalsAiConfig" в localStorage.
// Здесь только ЧТЕНИЕ и индикация — сама логика "ИИ-советника/командующего"
// это следующий большой пласт функциональности (см. футер).

function loadAiConfigStatus() {
  try {
    const raw = localStorage.getItem("generalsAiConfig");
    if (!raw) { logMsg("ИИ не настроен — откройте settings.html", "warn"); return; }
    const cfg = JSON.parse(raw);
    if (cfg.apiKey && cfg.model) {
      logMsg(`ИИ-модуль сконфигурирован: ${cfg.provider || "?"} / ${cfg.model}`);
    }
  } catch (e) {
    logMsg("Ошибка чтения конфигурации ИИ", "warn");
  }
}

/* ---------------------------- ИИ №4: вызов ИИ-советника из игры ---------------------------- */
// Раньше (см. футер ИИ №3) это было НЕ реализовано вообще — settings.html
// только сохранял конфиг, а game.html только читал его статус для лога.
// Здесь: кнопка в HUD собирает снапшот состояния партии, отправляет его
// как user-сообщение вместе с systemPrompt из конфига, и печатает ответ
// в #aiAdviceOutput (и дублирует в общий #log, чтобы совет было видно и
// среди остальных событий). Формат запроса переиспользует те же
// PROVIDER_PRESETS-подобные заголовки/тела, что и "Проверить соединение"
// в settings.html, чтобы два файла не расходились по формату API-вызова.
//
// ВАЖНО про безопасность/UX: если конфиг отсутствует, невалиден, ключ
// пуст, или сетевой запрос падает — игра НЕ должна ломаться. Все ветки
// обёрнуты в try/catch, кнопка блокируется на время запроса и разблокируется
// в finally.

// Дублирует PROVIDER_PRESETS из settings.html — намеренно НЕ импортируется
// оттуда (это два независимых статических HTML-файла без сборки/модулей),
// поэтому при изменении пресетов в settings.html ОБЯЗАТЕЛЬНО продублируй
// изменение и здесь, иначе "Проверить соединение" и реальный вызов из игры
// разъедутся по эндпоинтам/заголовкам. ПРОМПТ для след. ИИ: если увидишь
// расхождение — это баг рассинхронизации, а не два разных источника правды.
const AI_PROVIDER_PRESETS = {
  openrouter: { authHeaderName: "Authorization", authHeaderPrefix: "Bearer " },
  openai:     { authHeaderName: "Authorization", authHeaderPrefix: "Bearer " },
  anthropic:  { authHeaderName: "x-api-key",     authHeaderPrefix: "" },
  custom:     { authHeaderName: "Authorization", authHeaderPrefix: "Bearer " },
};

function getAiConfig() {
  const raw = localStorage.getItem("generalsAiConfig");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Собирает компактный текстовый снапшот состояния партии ЛОКАЛЬНОГО игрока:
// ресурсы, свои юниты (сгруппированы по типу), свои здания, и ВИДИМЫЕ вражеские
// силы. ИИ №6: фог войны теперь реализован (см. recomputeFogOfWar), поэтому
// снапшот честно ограничен тем, что игрок реально разведал —
// вражеские юниты фильтруются по State.fog.visible (видны прямо сейчас),
// вражеские здания — по State.fog.buildingGhosts (видны сейчас ИЛИ разведаны
// ранее и ещё не опровергнуты), т.е. ровно то же, что видит сам игрок на
// экране. Если фог отключён (GameConfig.fogEnabled=false), поведение как
// раньше — снапшот видит всё.
function buildGameSnapshot() {
  const player = State.players[localPlayerId];
  const myUnits = Object.values(State.units).filter(u => u.ownerId === localPlayerId);
  const myBuildings = Object.values(State.buildings).filter(b => b.ownerId === localPlayerId);

  let enemyUnitsList, enemyBuildingsList;
  if (GameConfig.fogEnabled) {
    enemyUnitsList = Object.values(State.units).filter(
      u => u.ownerId !== localPlayerId && isWorldPointVisible(u.x, u.y)
    );
    // buildingGhosts уже содержит и текущие видимые, и разведанные-по-памяти
    // вражеские здания — это именно те объекты, что реально отрисованы
    // игроку (либо как обычное здание, либо как тусклый "снимок").
    enemyBuildingsList = Object.values(State.fog.buildingGhosts);
  } else {
    enemyUnitsList = Object.values(State.units).filter(u => u.ownerId !== localPlayerId);
    enemyBuildingsList = Object.values(State.buildings).filter(b => b.ownerId !== localPlayerId);
  }

  function countByType(list) {
    const counts = {};
    list.forEach(x => { counts[x.type] = (counts[x.type] || 0) + 1; });
    return Object.entries(counts).map(([type, n]) => `${type}×${n}`).join(", ") || "нет";
  }

  const fogNote = GameConfig.fogEnabled
    ? " (только реально разведанные — честно, с учётом фога войны)"
    : " (фог войны выключен — видно всё)";

  return [
    `Кредиты: ${Math.floor(player.credits)}`,
    `Питание: ${player.power}/${player.powerUse}`,
    `Мои юниты: ${countByType(myUnits)}`,
    `Мои здания: ${countByType(myBuildings)}`,
    `Вражеские юниты${fogNote}: ${countByType(enemyUnitsList)}`,
    `Вражеские здания${fogNote}: ${countByType(enemyBuildingsList)}`,
    `Тик: ${State.tick}`,
  ].join("\n");
}

async function requestAiAdvice() {
  const btn = document.getElementById("aiAdviceBtn");
  const out = document.getElementById("aiAdviceOutput");
  const cfg = getAiConfig();

  if (!cfg || !cfg.apiKey || !cfg.model || !cfg.endpoint) {
    out.textContent = "ИИ не настроен. Откройте ⚙ Настройки ИИ и укажите ключ/модель/endpoint.";
    logMsg("Совет ИИ недоступен: конфигурация не заполнена", "warn");
    return;
  }

  btn.disabled = true;
  btn.textContent = "⏳ Запрос к ИИ...";
  out.textContent = "Собираю снапшот и жду ответа...";

  try {
    const snapshot = buildGameSnapshot();
    const preset = AI_PROVIDER_PRESETS[cfg.provider] || AI_PROVIDER_PRESETS.custom;
    const headers = { "Content-Type": "application/json" };
    headers[preset.authHeaderName] = preset.authHeaderPrefix + cfg.apiKey;
    if (cfg.provider === "anthropic") headers["anthropic-version"] = "2023-06-01";
    if (cfg.provider === "openrouter") {
      headers["HTTP-Referer"] = location.href;
      headers["X-Title"] = "Generals: Ashfront";
    }

    const systemPrompt = cfg.systemPrompt ||
      "Ты — тактический советник в RTS-игре. Дай короткий (1-2 фразы) практичный совет на русском.";

    let body;
    if (cfg.provider === "anthropic") {
      body = JSON.stringify({
        model: cfg.model,
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: "user", content: snapshot }],
      });
    } else {
      body = JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature != null ? cfg.temperature : 0.7,
        max_tokens: 200,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: snapshot },
        ],
      });
    }

    const resp = await fetch(cfg.endpoint, { method: "POST", headers, body });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();

    // Разбор ответа: у Anthropic content — массив блоков ({type:"text",text}),
    // у OpenAI-совместимых (включая OpenRouter) — choices[0].message.content.
    let advice = "";
    if (cfg.provider === "anthropic") {
      advice = (data.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    } else {
      advice = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content.trim() : "";
    }
    if (!advice) advice = "(ИИ вернул пустой ответ)";

    out.textContent = advice;
    logMsg(`Совет ИИ: ${advice}`);
  } catch (e) {
    out.textContent = "Ошибка запроса к ИИ: " + e.message;
    logMsg("Ошибка запроса совета ИИ: " + e.message, "warn");
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Совет ИИ-командующего";
  }
}

document.getElementById("aiAdviceBtn").addEventListener("click", requestAiAdvice);
