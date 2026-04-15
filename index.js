// ══════════════════════════════════════════════════════════════════════════════
// HULI AVAILABILITY REAL (usando el endpoint público que sí devuelve slots)
// ══════════════════════════════════════════════════════════════════════════════

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatHuliPublicDate(d) {
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "T" +
    pad2(d.getHours()) +
    pad2(d.getMinutes())
  );
}

function parseCompactTime(compact) {
  // Entrada esperada: 20260415T1530
  const m = String(compact || "").match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/
  );
  if (!m) return null;

  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

function isoDateFromCompact(compact) {
  const p = parseCompactTime(compact);
  if (!p) return "";

  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function hhmmFromCompact(compact) {
  const p = parseCompactTime(compact);
  if (!p) return "";

  return `${pad2(p.hour)}:${pad2(p.minute)}:00`;
}

function weekdayFromCompact(compact) {
  const p = parseCompactTime(compact);
  if (!p) return null;

  const d = new Date(p.year, p.month - 1, p.day);
  return d.getDay(); // 0 domingo ... 6 sábado
}

function minutesFromCompact(compact) {
  const p = parseCompactTime(compact);
  if (!p) return null;
  return p.hour * 60 + p.minute;
}

function isAllowedSlot(slot) {
  // slot.time viene como 20260415T1530
  if (!slot?.time) return false;

  const weekday = weekdayFromCompact(slot.time);
  const minutes = minutesFromCompact(slot.time);

  if (weekday === null || minutes === null) return false;

  return (
    ALLOWED_WEEKDAYS.has(weekday) &&
    minutes >= MIN_SLOT_MINUTES &&
    minutes <= MAX_SLOT_MINUTES
  );
}

async function huliGetPublicAvailability(from, to) {
  const fromParam = formatHuliPublicDate(from);
  const toParam = formatHuliPublicDate(to);

  const url =
    `https://app.hulivida.com/api/phr/es/doctor/${HULI_DOCTOR_ID}/availability` +
    `?from=${fromParam}&to=${toParam}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const raw = await res.text();
  const data = safeJsonParse(raw);

  if (!res.ok) {
    throw new Error(`Huli public availability ${res.status}: ${raw}`);
  }

  if (!data) {
    throw new Error(`Huli public availability sin JSON: ${raw}`);
  }

  return data;
}

async function huliGetSlotsInRange(from, to) {
  const data = await huliGetPublicAvailability(from, to);

  const responseData = data?.data?.response_data?.[0];
  const blocks = responseData?.availability?.slots || [];

  const slots = [];

  for (const dayBlock of blocks) {
    for (const slot of dayBlock.slots || []) {
      const candidate = {
        date: isoDateFromCompact(slot.time),
        date_l10n: dayBlock.dateL10nComp || dayBlock.dateL10n || "",
        time: hhmmFromCompact(slot.time),
        time_l10n: slot.timeL10n || "",
        source_event: slot.sourceEvent,
        raw_time: slot.time,
        dateTime: slot.dateTime,
      };

      if (!candidate.date || !candidate.time) continue;
      if (!isAllowedSlot(candidate)) continue;

      slots.push(candidate);
      if (slots.length >= 40) break;
    }

    if (slots.length >= 40) break;
  }

  console.log("──────── HULI PUBLIC AVAILABILITY ────────");
  console.log("from:", from.toString(), "->", formatHuliPublicDate(from));
  console.log("to:", to.toString(), "->", formatHuliPublicDate(to));
  console.log("blocks:", blocks.length);
  console.log("slots útiles:", slots.length);
  console.log("primeros 8:", JSON.stringify(slots.slice(0, 8), null, 2));
  console.log("──────────────────────────────────────────");

  return slots;
}

async function huliGetSlots(days = 14) {
  const from = new Date();
  from.setMinutes(0, 0, 0);

  const to = new Date(from);
  to.setDate(to.getDate() + days);

  return huliGetSlotsInRange(from, to);
}

function formatSlots(slots) {
  return (slots || [])
    .slice(0, 3)
    .map((s, i) => `${i + 1}. ${s.date_l10n} a las ${s.time_l10n}`)
    .join("\n");
}

function detectSlotChoice(msg, cls, slots) {
  if (!slots?.length) return null;

  const t = normalizeText(msg);

  if (
    t === "1" ||
    t.startsWith("1 ") ||
    t.startsWith("el 1") ||
    t.includes("primera") ||
    t.includes("primer")
  ) {
    return slots[0] || null;
  }

  if (
    t === "2" ||
    t.startsWith("2 ") ||
    t.startsWith("el 2") ||
    t.includes("segunda") ||
    t.includes("segundo")
  ) {
    return slots[1] || null;
  }

  if (
    t === "3" ||
    t.startsWith("3 ") ||
    t.startsWith("el 3") ||
    t.includes("tercera") ||
    t.includes("tercer")
  ) {
    return slots[2] || null;
  }

  if (cls?.slot_choice === "1") return slots[0] || null;
  if (cls?.slot_choice === "2") return slots[1] || null;
  if (cls?.slot_choice === "3") return slots[2] || null;

  for (const slot of slots) {
    const hhmm = slot.time.slice(0, 5);
    if (
      t.includes(normalizeText(slot.time_l10n)) ||
      t.includes(normalizeText(slot.date_l10n)) ||
      t.includes(hhmm)
    ) {
      return slot;
    }
  }

  return null;
}

async function ofrecerHorarios(state, datePreference = null) {
  if (!huliDisponible()) {
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    let slots = [];
    let contextMsg = "";

    if (datePreference) {
      const { from, to } = datePreferenceToRange(datePreference);
      slots = await huliGetSlotsInRange(from, to);
      contextMsg = `Para ${datePreference.text} `;
    } else {
      slots = await huliGetSlots(14);
    }

    if (!slots.length) {
      if (datePreference) {
        const fallbackSlots = await huliGetSlots(60);
        if (fallbackSlots.length) {
          state.slots = fallbackSlots.slice(0, 3);
          return `Para ${datePreference.text} no tengo espacios disponibles 😊

Lo más próximo que tengo es:
${formatSlots(state.slots)}

¿Cuál te queda mejor? (responde 1, 2 o 3)`;
        }
      }

      state.stage = "datos_manual";
      return `Claro 😊 En este momento no me está mostrando espacios disponibles en el sistema.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
    }

    state.slots = slots.slice(0, 3);

    const intro = datePreference
      ? `${contextMsg}tengo disponibilidad en:`
      : "Tengo disponibilidad en:";

    return `${intro}
${formatSlots(state.slots)}

¿Cuál te queda mejor? (responde 1, 2 o 3)`;
  } catch (e) {
    console.error("Huli public slots error:", e.message);

    state.stage = "datos_manual";
    return `Claro 😊 En este momento no me está mostrando espacios disponibles en el sistema.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
  }
}

async function ofrecerHorariosAlternativos(state, msg, cls) {
  if (cls?.preferred_schedule) {
    state.manualPreference = cls.preferred_schedule;
  }

  const newDatePref =
    detectDatePreference(msg) ||
    (cls?.date_preference ? detectDatePreference(cls.date_preference) : null);

  if (newDatePref) {
    state.datePreference = newDatePref;
    return await ofrecerHorarios(state, newDatePref);
  }

  if (!huliDisponible()) {
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    const currentIds = new Set((state.slots || []).map((s) => s.source_event));

    let allSlots = await huliGetSlots(21);
    let rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 3) {
      state.slots = rest.slice(0, 3);
      return `Claro 😊 También tengo:
${formatSlots(state.slots)}

¿Cuál te queda mejor? (responde 1, 2 o 3)`;
    }

    allSlots = await huliGetSlots(45);
    rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 3) {
      state.slots = rest.slice(0, 3);
      return `Claro 😊 Un poco más adelante tengo:
${formatSlots(state.slots)}

¿Cuál te queda mejor? (responde 1, 2 o 3)`;
    }

    state.stage = "datos_manual";
    return `Claro 😊 En este momento no me está mostrando más espacios en el sistema.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
  } catch (e) {
    console.error("Huli alt public slots error:", e.message);

    state.stage = "datos_manual";
    return `Claro 😊 En este momento no me está mostrando más espacios en el sistema.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
  }
}

async function ofrecerPrecioYHorarios(state, datePreference = null) {
  const slotsMsg = await ofrecerHorarios(state, datePreference);

  return `La consulta incluye valoración completa y ultrasonido 😊

El costo es ${CONSULTA_PRECIO}.

${slotsMsg}`;
}
