// Dashboard rendering and interactions.
    const numberFormat = new Intl.NumberFormat("es-PE");
    const dateFormat = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
    const monthYearFormat = new Intl.DateTimeFormat("es-PE", {
      month: "long", year: "numeric", timeZone: "UTC"
    });
    const monthNameFormat = new Intl.DateTimeFormat("es-PE", {
      month: "long", timeZone: "UTC"
    });
    const shortMonthFormat = new Intl.DateTimeFormat("es-PE", {
      month: "short", timeZone: "UTC"
    });
    const weekdayDateFormat = new Intl.DateTimeFormat("es-PE", {
      weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC"
    });
    const longDateFormat = new Intl.DateTimeFormat("es-PE", {
      dateStyle: "long", timeZone: "UTC"
    });
    let html2canvasPromise;

    // Load the PNG export dependency only after a user requests an export.
    function loadHtml2Canvas() {
      if (typeof window.html2canvas === "function") {
        return Promise.resolve(window.html2canvas);
      }
      if (!html2canvasPromise) {
        html2canvasPromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "/static/vendor/html2canvas.min.js";
          script.async = true;
          script.onload = () => {
            if (typeof window.html2canvas !== "function") {
              html2canvasPromise = null;
              reject(new Error("No se pudo inicializar la exportación de imágenes."));
              return;
            }
            resolve(window.html2canvas);
          };
          script.onerror = () => {
            html2canvasPromise = null;
            reject(new Error("No se pudo cargar la exportación de imágenes."));
          };
          document.head.append(script);
        });
      }
      return html2canvasPromise;
    }

    const filterIds = ["area", "gestor", "tipo", "motivo", "submotivo", "alerta_solucion", "condicion_usuario", "condicion_final_usuario", "empresa", "canal", "desde", "hasta", "buscar"];
    let basePeriod;
    let activeUploadedFilename = "";
    let lastSourceVersion;
    let searchTimer;
    let activeRequest;
    let activeCaseRequest;
    let activeAdvisorFlowRequest;
    let activeDetail = "";
    let activeReportFilter = {};
    let activePage = 1;
    let followupPage = 1;
    let displayedCases = [];
    let displayedFollowupCases = [];
    let chartYears = [];
    let chartMonths = [];
    let chartWeeks = [];
    let chartDays = [];
    let chartKpis = {};
    let selectedChartYear = null;
    let selectedChartMonth = null;
    let selectedChartWeek = null;
    let selectedChartDay = null;
    let chartBaseDateRange = null;
    let caseDetailReturnScrollY = null;
    let caseDetailReturnView = "dashboard";
    let caseDetailReturnFilters = null;
    let selectedAreaEfficiencyAdvisor = "";
    let latestAreaEfficiencyResult = null;
    let advisorWeekMode = "weekly";
    let latestAdvisorWeekData = null;
    let latestAdvisorMonthData = null;
    let advisorReceivedMode = "weekly";
    let advisorDerivedMode = "weekly";
    let advisorOutgoingMode = "weekly";
    let latestAdvisorFlowData = null;
    let advisorDirectory = [];
    let allAdvisorOptions = [];
    let motiveHierarchy = [];
    let allMotiveOptions = [];
    let allSubmotiveOptions = [];

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    }

    function caseRowAttributes(detail, filters = {}) {
      const filterAttributes = Object.entries(filters)
        .filter(([, value]) => value)
        .map(([name, value]) =>
          `data-case-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeHtml(value)}"`
        )
        .join(" ");
      return `data-case-detail="${detail}" ${filterAttributes}`;
    }

    function caseNumberCell(value, reportFilter = {}, cellOptions = {}) {
      const filterAttributes = Object.entries(reportFilter)
        .filter(([, filterValue]) => filterValue)
        .map(([name, filterValue]) =>
          `data-case-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeHtml(filterValue)}"`
        )
        .join(" ");
      const rowSpan = cellOptions.rowSpan ? `rowspan="${cellOptions.rowSpan}"` : "";
      const detail = cellOptions.detail
        ? `data-case-detail="${escapeHtml(cellOptions.detail)}"`
        : "";
      return `<td ${rowSpan} ${detail} data-case-number="true" role="button" tabindex="0"
        aria-label="Ver detalle de ${numberFormat.format(value)} casos" ${filterAttributes}>${numberFormat.format(value)}</td>`;
    }

    function percentage(value, total) {
      return total ? `${(value * 100 / total).toFixed(1)}%` : "0%";
    }

    function renderCards(containerId, cards, hero = false) {
      document.getElementById(containerId).innerHTML = cards.map(([label, value, note, color, detail]) => `
        <button type="button" class="detail-trigger ${hero ? "card hero-card" : "card"}" data-detail="${detail}" style="--accent:${color}">
          <div class="${hero ? "hero-label" : "card-label"}">${label}</div>
          <div class="${hero ? "hero-value" : "card-value"}">${numberFormat.format(value)}</div>
          <div class="${hero ? "hero-note" : "card-note"}">${note}</div>
        </button>`).join("");
    }

    function renderDetailMetrics(containerId, metrics) {
      document.getElementById(containerId).innerHTML = metrics.map(([label, value, detail]) => `
        <button type="button" class="submetric detail-trigger" data-detail="${detail}">
          <div class="submetric-label">${label}</div><div class="submetric-value">${numberFormat.format(value)}</div>
        </button>`).join("");
    }

    function renderMetrics(kpis, outgoingMode = false, category = "TODAS") {
      renderCards("hero-metrics", [
        [outgoingMode ? "Total de casos salientes" : "Total de casos ingresados", kpis.total,
          outgoingMode ? "Suma según SUMA CASOS SALIENTES" : "Suma según SUMA TOTAL INGRESADOS", "#2874bd", "total"],
        ["Solucionados", kpis.solucionados, `${percentage(kpis.solucionados, kpis.total)} del total · cerrados + derivados atendidos`, "#24a092", "solucionados"],
        ["No solucionados", kpis.no_solucionados, `${percentage(kpis.no_solucionados, kpis.total)} del total`, "#ed7658", "no_solucionados"],
        ["Consultas", kpis.consultas, `${percentage(kpis.consultas, kpis.total)} del total`, "#28a0a4", "consultas"],
        ["Reclamos", kpis.reclamos, `${percentage(kpis.reclamos, kpis.total)} del total`, "#e7a537", "reclamos"]
      ], true);

      document.getElementById("received-nonderived-total").textContent = numberFormat.format(kpis.recibidos_no_derivados);
      document.getElementById("received-derived-total").textContent = numberFormat.format(kpis.recibidos_derivados);
      renderDetailMetrics("received-nonderived-breakdown", [
        ["CERRADO", kpis.cerrados_no_derivados, "recibidos_cerrados"],
        ["PENDIENTE DE CIERRE", kpis.pendiente_cierre, "recibidos_pendiente_cierre"],
        ["SIN CONDICIÓN", kpis.cierre_sin_condicion, "recibidos_sin_condicion"]
      ]);
      renderDetailMetrics("received-derived-breakdown", [
        ["ATENDIDO", kpis.atendidos_derivados, "recibidos_atendidos"],
        ["PENDIENTE DE ATENCIÓN", kpis.pendiente_atencion, "recibidos_pendiente_atencion"],
        ["SIN CONDICIÓN FINAL", kpis.sin_condicion_final, "recibidos_sin_condicion_final"]
      ]);
      renderDetailMetrics("outgoing-breakdown", [
        ["ATENDIDO", kpis.salientes_atendidos, "salientes_atendidos"],
        ["PENDIENTE DE ATENCIÓN", kpis.salientes_pendiente_atencion, "salientes_pendiente_atencion"],
        ["SIN CONDICIÓN FINAL", kpis.salientes_sin_condicion_final, "salientes_sin_condicion_final"]
      ]);

      document.getElementById("outgoing-total").textContent = numberFormat.format(kpis.salientes);
      document.getElementById("breakdown-nonderived").hidden =
        !["TODAS", "RECIBIDOS_NO_DERIVADOS"].includes(category);
      document.getElementById("breakdown-derived").hidden =
        !["TODAS", "RECIBIDOS_DERIVADOS"].includes(category);
      document.getElementById("breakdown-outgoing").hidden =
        !["TODAS", "SALIENTES"].includes(category);
    }

    function renderIncomeChart(years, months, weeks, days, kpis, selectedYear = null, selectedMonth = null, selectedWeek = null, outgoingMode = false) {
      const container = document.getElementById("monthly-chart");
      const title = document.getElementById("income-chart-title");
      const subtitle = document.getElementById("income-chart-subtitle");
      const backButton = document.getElementById("chart-back");
      const periodMetric = outgoingMode ? "salidas" : "ingresos";
      const periodTitle = outgoingMode ? "Salidas contabilizadas" : "Ingresos contabilizados";
      const yearData = selectedYear === null
        ? null
        : years.find((item) => item.anio === selectedYear);
      const monthKey = selectedYear === null || selectedMonth === null
        ? null
        : `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
      const monthData = monthKey === null
        ? null
        : months.find((item) => item.mes === monthKey);
      const monthLabel = selectedMonth === null
        ? null
        : monthYearFormat.format(new Date(Date.UTC(selectedYear, selectedMonth - 1, 1)));
      const items = selectedWeek !== null
        ? (() => {
            const dailyData = new Map(days.map((item) => [item.fecha, item]));
            const dailyItems = [];
            const start = new Date(`${selectedWeek.start}T00:00:00Z`);
            const end = new Date(`${selectedWeek.end}T00:00:00Z`);
            for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
              const dateKey = cursor.toISOString().slice(0, 10);
              const dayData = dailyData.get(dateKey) || {};
              const dayLabel = weekdayDateFormat.format(cursor).replace(".", "");
              const fullDate = longDateFormat.format(cursor);
              dailyItems.push({
                ...dayData,
                label: dayLabel,
                tooltip: `${fullDate}: ${numberFormat.format(dayData.cantidad || 0)} ${periodMetric}`,
                cantidad: dayData.cantidad || 0
              });
            }
            return dailyItems;
          })()
        : selectedYear === null
        ? years.map((item) => ({ ...item, label: String(item.anio), year: item.anio }))
        : selectedMonth === null
          ? Array.from({ length: 12 }, (_, index) => {
            const monthNumber = index + 1;
            const monthKey = `${selectedYear}-${String(monthNumber).padStart(2, "0")}`;
            const monthData = months.find((item) => item.mes === monthKey);
            const monthLabel = shortMonthFormat
              .format(new Date(Date.UTC(selectedYear, index, 1))).replace(".", "");
            return {
              ...(monthData || { cantidad: 0 }),
              label: monthLabel,
              mes: monthKey,
              year: selectedYear
            };
          })
          : (() => {
              const firstDay = new Date(Date.UTC(selectedYear, selectedMonth - 1, 1));
              const lastDay = new Date(Date.UTC(selectedYear, selectedMonth, 0));
              const weeklyData = new Map(
                weeks
                  .filter((item) => item.mes === monthKey)
                  .map((item) => [item.semana_inicio, item])
              );
              const monthItems = [];
              for (let cursor = firstDay; cursor <= lastDay;) {
                const weekStart = new Date(cursor);
                weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
                const weekEnd = new Date(weekStart);
                weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
                const visibleEnd = weekEnd < lastDay ? weekEnd : lastDay;
                const key = weekStart.toISOString().slice(0, 10);
                const weekData = weeklyData.get(key) || {};
                const formatWeekDate = (date) => [
                  String(date.getUTCDate()).padStart(2, "0"),
                  String(date.getUTCMonth() + 1).padStart(2, "0"),
                  String(date.getUTCFullYear()).slice(-2)
                ].join("/");
                const weekLabel = `${formatWeekDate(cursor)} - ${formatWeekDate(visibleEnd)}`;
                monthItems.push({
                  ...weekData,
                  label: weekLabel,
                  tooltip: `Semana calendario · ${weekLabel}`,
                  semana_inicio_visible: cursor.toISOString().slice(0, 10),
                  semana_fin_visible: visibleEnd.toISOString().slice(0, 10),
                  cantidad: weekData.cantidad || 0
                });
                cursor = new Date(visibleEnd);
                cursor.setUTCDate(cursor.getUTCDate() + 1);
              }
              return monthItems;
            })();
      title.textContent = selectedYear === null
        ? `${periodTitle} por año`
        : selectedMonth === null
          ? `${periodTitle} por mes · ${selectedYear}`
          : selectedWeek === null
            ? `${periodTitle} por semana · ${monthLabel}`
            : `${periodTitle} por día · ${monthLabel}`;
      subtitle.textContent = selectedYear === null
        ? "Años dentro del periodo filtrado"
        : selectedMonth === null
          ? `Meses del ${selectedYear} dentro del periodo filtrado`
          : selectedWeek === null
            ? "Semanas calendario de lunes a domingo; semanas parciales al inicio o fin del mes"
            : `${outgoingMode ? "Casos salientes" : "Casos ingresados"} cada día de la semana seleccionada`;
      backButton.hidden = false;
      backButton.disabled = selectedYear === null && !document.getElementById("area").value;
      const backLabel = selectedYear === null
        ? "Mostrar todas las áreas"
        : selectedWeek !== null
          ? "Volver a semanas"
          : selectedMonth === null
            ? "Volver a años"
            : "Volver a meses";
      const accessibleBackLabel = backLabel;
      backButton.setAttribute("aria-label", accessibleBackLabel);
      backButton.title = accessibleBackLabel;
      if (!items.length) {
        container.innerHTML = '<div class="empty">No hay casos para este periodo.</div>';
      } else {
        const max = Math.max(...items.map((item) => item.cantidad), 1);
        container.innerHTML = items.map((item) => {
        const height = Math.max(3, item.cantidad * 145 / max);
        const tag = "button";
        const chartAttributes = selectedYear === null
          ? `type="button" data-chart-year="${item.year}" aria-label="Ver meses del año ${item.year}"`
          : selectedMonth === null
            ? `type="button" data-chart-month="${Number(item.mes.split("-")[1])}" aria-label="Ver semanas de ${escapeHtml(item.label)} de ${selectedYear}"`
            : selectedWeek === null
              ? `type="button" data-chart-week-start="${item.semana_inicio_visible}" data-chart-week-end="${item.semana_fin_visible}" aria-label="Ver días de ${escapeHtml(item.label)}"`
              : `type="button" data-chart-day="${item.fecha}" aria-label="Filtrar áreas por ${escapeHtml(item.label)}"`;
        const itemTitle = item.tooltip || `${item.year}: ${numberFormat.format(item.cantidad)} ${periodMetric}`;
        return `<${tag} class="month-column" ${chartAttributes} title="${escapeHtml(itemTitle)}">
          <span class="month-count">${numberFormat.format(item.cantidad)}</span>
          <div class="month-bar" style="height:${height}px"></div>
          <span class="month-label">${escapeHtml(item.label)}</span>
        </${tag}>`;
        }).join("");
      }

      const total = selectedYear === null
        ? years.reduce((sum, item) => sum + item.cantidad, 0)
        : selectedMonth === null
          ? yearData?.cantidad || 0
          : selectedWeek !== null
            ? days.filter((item) => item.fecha >= selectedWeek.start && item.fecha <= selectedWeek.end)
                .reduce((sum, item) => sum + item.cantidad, 0)
            : monthData?.cantidad || 0;
      const summaryMetrics = selectedMonth === null
        ? yearData || kpis
        : selectedWeek !== null
          ? days.filter((item) => item.fecha >= selectedWeek.start && item.fecha <= selectedWeek.end)
              .reduce((totals, item) => ({
                solucionados: totals.solucionados + item.solucionados,
                no_solucionados: totals.no_solucionados + item.no_solucionados,
                consultas: totals.consultas + item.consultas,
                reclamos: totals.reclamos + item.reclamos
              }), { solucionados: 0, no_solucionados: 0, consultas: 0, reclamos: 0 })
          : monthData || {
              solucionados: 0,
              no_solucionados: 0,
              consultas: 0,
              reclamos: 0
            };
      renderMonthlySummary(total, summaryMetrics, outgoingMode);
    }

    function renderMonthlySummary(periodTotal, metrics, outgoingMode = false) {
      const summary = [
        [outgoingMode ? "Total casos salientes" : "Total casos ingresados", periodTotal, outgoingMode ? "salientes" : "total"],
        ["Solucionados", metrics.solucionados, "solucionados"],
        ["No solucionados", metrics.no_solucionados, "no_solucionados"],
        ["Consultas", metrics.consultas, "consultas"],
        ["Reclamos", metrics.reclamos, "reclamos"]
      ];
      document.getElementById("monthly-summary").innerHTML = summary.map(([label, value, detail]) => `
        <button type="button" class="monthly-summary-item detail-trigger" data-detail="${detail}">
          <div class="monthly-summary-label">${label}</div>
          <div class="monthly-summary-value">${numberFormat.format(value)}</div>
        </button>
      `).join("");
    }

    function renderAreaChart(items, outgoingMode = false) {
      const container = document.getElementById("area-chart");
      const selectedArea = document.getElementById("area").value;
      document.getElementById("area-chart-back").hidden = !selectedArea;
      if (!items.length) {
        container.innerHTML = '<div class="empty">No hay datos por área.</div>';
        return;
      }
      const maximum = Math.max(...items.map((item) => item.cantidad), 1);
      const totalWidth = items.map((item) => Math.max(3, item.cantidad * 100 / maximum));
      container.innerHTML = items.map((item, index) => {
        const width = totalWidth[index];
        return `<button type="button" class="area-chart-item area-chart-select" data-area-select="${escapeHtml(item.nombre)}"
          aria-label="Mostrar datos de ${escapeHtml(item.nombre)}" aria-pressed="${selectedArea === item.nombre}">
          <div class="area-chart-heading">
            <span>${escapeHtml(item.nombre)}</span>
            <strong>${numberFormat.format(item.cantidad)}</strong>
          </div>
          <div class="area-chart-track" aria-label="${escapeHtml(item.nombre)}: ${numberFormat.format(item.cantidad)} casos" role="img">
            <div class="area-chart-solved" style="width:${width}%"></div>
          </div>
        </button>`;
      }).join("");
    }

    function renderBars(containerId, items, filterId) {
      const container = document.getElementById(containerId);
      if (!items.length) {
        container.innerHTML = '<div class="empty">Sin datos para mostrar.</div>';
        return;
      }
      const max = Math.max(...items.map((item) => item.cantidad), 1);
      container.innerHTML = items.map((item) => `
        <div class="bar-item category-bar-item" data-category-filter="${filterId}" data-category-value="${escapeHtml(item.nombre)}"
          role="button" tabindex="0" aria-label="Ver casos de ${escapeHtml(item.nombre)}">
          <div class="bar-heading"><span title="${escapeHtml(item.nombre)}">${escapeHtml(item.nombre)}</span><strong>${numberFormat.format(item.cantidad)}</strong></div>
          <div class="track"><div class="fill" style="width:${Math.max(3, item.cantidad * 100 / max)}%"></div></div>
        </div>`).join("");
    }

    function renderReasonChart(motives, submotives, selectedMotive) {
      const container = document.getElementById("reason-chart");
      const showingSubmotives = Boolean(selectedMotive);
      const items = showingSubmotives ? submotives : motives;
      const title = document.getElementById("reason-chart-title");
      const subtitle = document.getElementById("reason-chart-subtitle");
      const backButton = document.getElementById("reason-chart-back");
      title.textContent = showingSubmotives ? `Submotivos de ${selectedMotive}` : "Motivos principales";
      subtitle.textContent = showingSubmotives
        ? "Selecciona un submotivo para ver sus casos"
        : "Selecciona un motivo para ver sus submotivos";
      backButton.hidden = !showingSubmotives;

      if (!items.length) {
          container.innerHTML = '<div class="empty">Sin datos para mostrar.</div>';
          return;
      }

      const max = Math.max(...items.map((item) => item.cantidad), 1);
      container.innerHTML = items.map((item) => {
        const reasonAttributes = showingSubmotives
          ? `data-submotivo="${escapeHtml(item.nombre)}" role="button" tabindex="0" aria-label="Ver casos con submotivo ${escapeHtml(item.nombre)}"`
          : `data-reason="${escapeHtml(item.nombre)}" role="button" tabindex="0" aria-label="Ver submotivos de ${escapeHtml(item.nombre)}"`;
        return `<div class="bar-item ${showingSubmotives ? "submotif-bar-item" : "reason-bar-item"}" ${reasonAttributes}>
            <div class="bar-heading"><span title="${escapeHtml(item.nombre)}">${escapeHtml(item.nombre)}</span><strong>${numberFormat.format(item.cantidad)}</strong></div>
            <div class="track"><div class="fill" style="width:${Math.max(3, item.cantidad * 100 / max)}%"></div></div>
          </div>`;
      }).join("");
    }

          function renderQuality(items) {
      document.getElementById("quality-grid").innerHTML = items.map((item) => `
        <button type="button" class="quality-item detail-trigger" data-detail="${item.detail}">
          <span>${escapeHtml(item.nombre)}</span>
          <strong>${numberFormat.format(item.cantidad)}</strong>
        </button>
      `).join("");
    }

          function renderAreaEfficiency(result) {
            const summary = result.resumen_eficiencia_areas;
            const body = document.getElementById("area-efficiency-body");
            const foot = document.getElementById("area-efficiency-foot");
            const count = document.getElementById("area-efficiency-count");
            const subtitle = document.getElementById("area-efficiency-subtitle");
            if (!summary) {
              body.innerHTML = '<tr><td colspan="13" class="empty">Reinicia el servidor para cargar el resumen por área.</td></tr>';
              foot.innerHTML = "";
              count.textContent = "";
              return;
            }

            latestAreaEfficiencyResult = result;
            const selectedArea = document.getElementById("area").value;
            const rows = selectedArea
              ? (result.resumen_eficiencia_asesores || []).filter((record) => record.area === selectedArea)
              : summary.registros || [];
            const visibleRows = selectedAreaEfficiencyAdvisor
              ? rows.filter((record) => record.asesor === selectedAreaEfficiencyAdvisor)
              : rows;
            const total = selectedAreaEfficiencyAdvisor
              ? visibleRows.length
                ? { ...visibleRows[0], area: "TOTAL DEL ÁREA", asesor: "", porcentaje_total_gestionados: 100 }
                : null
              : summary.total;
            const backButton = document.getElementById("area-efficiency-back");
            backButton.hidden = !selectedArea;
            backButton.setAttribute("aria-label", selectedAreaEfficiencyAdvisor
              ? "Mostrar todos los asesores"
              : "Volver a todas las áreas");
            backButton.title = selectedAreaEfficiencyAdvisor
              ? "Mostrar todos los asesores"
              : "Volver a todas las áreas";
            document.getElementById("area-efficiency-title").textContent = selectedAreaEfficiencyAdvisor
              ? `Resumen de gestión por asesor: ${selectedArea}`
              : selectedArea
                ? `Resumen de gestión por área: ${selectedArea}`
                : "Resumen de gestión por área";
            document.getElementById("area-efficiency-row-label").textContent =
              selectedArea ? "ASESOR" : "ÁREA";
            const percentFormat = new Intl.NumberFormat("es-PE", {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1
            });
            const efficiencyFormat = new Intl.NumberFormat("es-PE", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            });
            const percent = (value) => value === null || value === undefined
              ? "—"
              : `${percentFormat.format(value)}%`;
            const days = (value) => value === null || value === undefined
              ? "—"
              : percentFormat.format(value);
            const stateClass = {
              "ÓPTIMO": "optimal",
              "REGULAR": "watch",
              "MALO": "low",
              "--": "empty"
            };
            const renderRow = (record, totalRow = false) => {
              const areaName = record.area || selectedArea;
              const advisorName = record.asesor || "";
              const scope = totalRow
                ? (selectedArea ? `del área ${selectedArea}` : "del período")
                : advisorName
                  ? `del asesor ${advisorName} en el área ${areaName}`
                  : `del área ${areaName}`;
              return `<tr data-breakdown-kind="area-gestion"
                data-breakdown-area="${escapeHtml(areaName || "")}"
                data-breakdown-advisor="${escapeHtml(advisorName)}"
                data-breakdown-total="${totalRow}">
                <td ${!advisorName && !totalRow
                  ? `data-area-filter="${escapeHtml(areaName || "")}" role="button" tabindex="0" aria-label="Mostrar asesores del área ${escapeHtml(areaName || "")}"`
                  : selectedArea && advisorName && !totalRow
                    ? `data-advisor-filter="${escapeHtml(advisorName)}" role="button" tabindex="0" aria-label="Mostrar solo a ${escapeHtml(advisorName)}"`
                    : ""}>${escapeHtml(record.asesor || record.area)}</td>
                ${caseBreakdownCountCell(record.total_gestionados, `Ver ${record.total_gestionados} casos gestionados ${scope}`, "total", "area-efficiency-management area-efficiency-group-start")}
                <td class="area-efficiency-management">${percent(record.porcentaje_total_gestionados)}</td>
                <td class="area-efficiency-management">${days(record.promedio_dias)}</td>
                <td class="area-efficiency-management">${percent(record.porcentaje_tiempo)}</td>
                ${caseBreakdownCountCell(record.solucionados, `Ver ${record.solucionados} casos solucionados ${scope}`, "solucionados", "area-efficiency-solved area-efficiency-group-start")}
                <td class="area-efficiency-solved">${percent(record.porcentaje_solucionados)}</td>
                <td class="area-efficiency-solved">${days(record.promedio_dias_solucionados)}</td>
                ${caseBreakdownCountCell(record.no_solucionados, `Ver ${record.no_solucionados} casos no solucionados ${scope}`, "no_solucionados", "area-efficiency-unsolved area-efficiency-group-start")}
                <td class="area-efficiency-unsolved">${percent(record.porcentaje_no_solucionados)}</td>
                <td class="area-efficiency-unsolved">${days(record.promedio_dias_no_solucionados)}</td>
                <td class="area-efficiency-performance area-efficiency-group-start">${record.eficiencia_general === null
                  ? "—"
                  : `${efficiencyFormat.format(record.eficiencia_general)}%`}</td>
                <td class="area-efficiency-performance area-efficiency-status area-efficiency-status-${stateClass[record.estado] || "empty"}">${escapeHtml(record.estado)}</td>
              </tr>`;
            };

            body.innerHTML = visibleRows.length
              ? visibleRows.map((record) => renderRow(record)).join("")
              : `<tr><td colspan="13" class="empty">${selectedArea
                ? "No hay asesores con casos para el área y los filtros seleccionados."
                : "No hay áreas con casos para los filtros seleccionados."}</td></tr>`;
            foot.innerHTML = total
              ? renderRow(total, true)
              : "";
            count.textContent = `${numberFormat.format(visibleRows.length)} ${visibleRows.length === 1
              ? selectedArea ? "asesor" : "área"
              : selectedArea ? "asesores" : "áreas"}`;
            const periodData = result.resumen_asesores || {};
            const periodStart = periodData.desde || (result.periodo && result.periodo.desde);
            const periodEnd = periodData.hasta || (result.periodo && result.periodo.hasta);
            const periodLabel = periodStart && periodEnd
              ? `${formatDate(periodStart)} al ${formatDate(periodEnd)}`
              : "sin fechas disponibles";
            subtitle.textContent = selectedArea
              ? `Asesores del área ${selectedArea} · Período: ${periodLabel} · Estado: ÓPTIMO ≥90%, REGULAR >70% y <90%, MALO ≤70%; -- sin casos.`
              : `Período: ${periodLabel} · Estado: ÓPTIMO ≥90%, REGULAR >70% y <90%, MALO ≤70%; -- sin casos.`;
          }

    function renderAreaEfficiencyCharts(summary, advisorSummary) {
      const kpis = document.getElementById("area-efficiency-kpis");
      const pie = document.getElementById("area-efficiency-pie");
      const bars = document.getElementById("area-efficiency-bars");
      const bestAdvisors = document.getElementById("area-best-advisors");
      if (!summary || !summary.total) {
        kpis.innerHTML = "";
        pie.innerHTML = '<div class="empty">No hay datos para graficar.</div>';
        bars.innerHTML = '<div class="empty">No hay datos para graficar.</div>';
        bestAdvisors.innerHTML = '<div class="empty">No hay asesores para este período y estos filtros.</div>';
        return;
      }

      const total = summary.total;
      const rows = summary.registros || [];
      const percentFormat = new Intl.NumberFormat("es-PE", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      });
      const efficiencyFormat = new Intl.NumberFormat("es-PE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      const percent = (value) => value === null || value === undefined
        ? "—"
        : `${percentFormat.format(value)}%`;
      const averageDays = (value) => value === null || value === undefined
        ? "—"
        : percentFormat.format(value);
      const stateClasses = {
        "ÓPTIMO": "optimal",
        "REGULAR": "watch",
        "MALO": "low",
        "--": "empty"
      };
      const metricCard = (label, value, detail, color, progress, isCount = false, state = "") => {
        const progressValue = Math.max(0, Math.min(100, Number(progress) || 0));
        const ringClass = isCount ? "area-efficiency-kpi-ring-total" : "";
        const ringStyle = isCount
          ? ""
          : `style="--ring-value:${progressValue}%;--ring-color:${color}"`;
        const stateChip = state
          ? `<span class="area-efficiency-state-chip ${stateClasses[state] || "empty"}">${escapeHtml(state)}</span>`
          : "";
        return `<article class="area-efficiency-kpi">
          <div class="area-efficiency-kpi-ring ${ringClass}" ${ringStyle}><span>${value}</span></div>
          <div class="area-efficiency-kpi-copy">
            <span class="area-efficiency-kpi-meta">${label}</span>
            <strong class="area-efficiency-kpi-value">${detail}</strong>
            ${stateChip}
          </div>
        </article>`;
      };

      const efficiencyValue = total.eficiencia_general;
      kpis.innerHTML = [
        metricCard(
          "Casos gestionados",
          numberFormat.format(total.total_gestionados),
          `${numberFormat.format(rows.length)} áreas`,
          "#315f9d",
          100,
          true
        ),
        metricCard(
          "% solucionados",
          percent(total.porcentaje_solucionados),
          `${numberFormat.format(total.solucionados)} casos de ${numberFormat.format(total.total_gestionados)} casos`,
          "#21816d",
          total.porcentaje_solucionados
        ),
        metricCard(
          "% INDICADOR<br>PROMEDIO DÍAS",
          percent(total.porcentaje_tiempo),
          `${averageDays(total.promedio_dias)} días<br>para solucionar un caso`,
          "#5aa5d2",
          total.porcentaje_tiempo
        ),
        metricCard(
          "Eficiencia general",
          efficiencyValue === null ? "—" : `${efficiencyFormat.format(efficiencyValue)}%`,
          "Resultado general",
          "#584ca7",
          efficiencyValue,
          false,
          total.estado
        )
      ].join("");

      const advisorRows = (advisorSummary && advisorSummary.registros || [])
        .filter((record) => Number(record.total) > 0);
      const advisorsByArea = new Map();
      advisorRows.forEach((record) => {
        const area = record.area || "SIN ÁREA";
        const areaAdvisors = advisorsByArea.get(area) || [];
        areaAdvisors.push(record);
        advisorsByArea.set(area, areaAdvisors);
      });
      const bestAdvisorCards = [...advisorsByArea.entries()].map(([area, records]) => {
        const efficiency = (record) =>
          (Number(record.solucionados) + Number(record.en_plazo)) * 100
          / (2 * Number(record.total));
        const winner = [...records].sort((left, right) =>
          efficiency(right) - efficiency(left)
          || Number(right.solucionados) - Number(left.solucionados)
          || Number(right.total) - Number(left.total)
          || String(left.asesor).localeCompare(String(right.asesor), "es")
        )[0];
        const winnerEfficiency = efficiency(winner);
        const caseLabel = Number(winner.total) === 1 ? "caso" : "casos";
        const solvedLabel = Number(winner.solucionados) === 1 ? "solucionado" : "solucionados";
        return {
          area,
          efficiency: winnerEfficiency,
          markup: `<article class="area-best-advisor-card">
            <span class="area-best-advisor-area">${escapeHtml(area)}</span>
            <span class="area-best-advisor-name">${escapeHtml(winner.asesor || "SIN ASESOR")}</span>
            <span class="area-best-advisor-detail">${efficiencyFormat.format(winnerEfficiency)}% de eficiencia · ${numberFormat.format(winner.solucionados)} de ${numberFormat.format(winner.total)} ${caseLabel} ${solvedLabel}</span>
          </article>`
        };
      }).sort((left, right) =>
        right.efficiency - left.efficiency
        || Number(!left.area.toLocaleUpperCase("es").startsWith("AREA ACADEMICA"))
          - Number(!right.area.toLocaleUpperCase("es").startsWith("AREA ACADEMICA"))
        || left.area.localeCompare(right.area, "es")
      );
      bestAdvisors.innerHTML = bestAdvisorCards.length
        ? bestAdvisorCards.map((card) => card.markup).join("")
        : '<div class="empty">No hay asesores para este período y estos filtros.</div>';

      const colors = ["#0072b2", "#e69f00", "#009e73", "#d55e00", "#cc79a7", "#56b4e9", "#6f4e9c"];
      const pieRows = rows.filter((record) => Number(record.total_gestionados) > 0);
      const totalCases = Number(total.total_gestionados) || 0;
      if (!pieRows.length || !totalCases) {
        pie.innerHTML = '<div class="empty">No hay casos por área para estos filtros.</div>';
      } else {
        let progress = 0;
        const segments = pieRows.map((record, index) => {
          const share = Number(record.total_gestionados) * 100 / totalCases;
          const end = progress + share;
          const segment = `${colors[index % colors.length]} ${progress}% ${end}%`;
          progress = end;
          return segment;
        });
        const legend = pieRows.map((record, index) => {
          const share = Number(record.total_gestionados) * 100 / totalCases;
          return `<li>
            <span class="area-efficiency-legend-swatch" style="--segment-color:${colors[index % colors.length]}"></span>
            <span class="area-efficiency-legend-name" title="${escapeHtml(record.area)}">${escapeHtml(record.area)}</span>
            <strong>${numberFormat.format(record.total_gestionados)} · ${percentFormat.format(share)}%</strong>
          </li>`;
        }).join("");
        pie.innerHTML = `<div class="area-efficiency-pie-layout">
          <div class="area-efficiency-donut" role="img" aria-label="Distribución de ${numberFormat.format(totalCases)} casos gestionados por área" style="background:conic-gradient(${segments.join(",")})">
            <div class="area-efficiency-donut-center">
              <strong>${numberFormat.format(totalCases)}</strong><span>casos</span>
            </div>
          </div>
          <ul class="area-efficiency-legend">${legend}</ul>
        </div>`;
      }

      const efficiencyRows = [...pieRows].sort((left, right) =>
        (Number(right.eficiencia_general) || 0) - (Number(left.eficiencia_general) || 0)
      );
      const stateColors = {
        "ÓPTIMO": "#21816d",
        "REGULAR": "#d5961b",
        "MALO": "#c75d4a",
        "--": "#8493a3"
      };
      bars.innerHTML = efficiencyRows.length
        ? efficiencyRows.map((record) => {
          const solutionContribution = Math.max(
            0, Math.min(50, (Number(record.porcentaje_solucionados) || 0) / 2)
          );
          const timeContribution = Math.max(
            0, Math.min(50, (Number(record.porcentaje_tiempo) || 0) / 2)
          );
          const value = record.eficiencia_general === null
            ? "—"
            : `${efficiencyFormat.format(record.eficiencia_general)}%`;
          const status = stateClasses[record.estado] || "empty";
          return `<div class="area-efficiency-bar-row">
            <div class="area-efficiency-bar-heading">
              <span title="${escapeHtml(record.area)}">${escapeHtml(record.area)}</span>
              <strong>${value}</strong>
              <span class="area-efficiency-state-chip ${status}">${escapeHtml(record.estado)}</span>
            </div>
            <div class="area-efficiency-bar-track" role="img" aria-label="${escapeHtml(record.area)}: ${value} de eficiencia general">
              <span class="area-efficiency-bar-solved" style="width:${solutionContribution}%"></span>
              <span class="area-efficiency-bar-time" style="width:${timeContribution}%"></span>
            </div>
            <div class="area-efficiency-bar-details">
              <span>Solucionados ${percent(record.porcentaje_solucionados)} <strong>de ${numberFormat.format(record.total_gestionados)} casos</strong></span>
              <span>Promedio de días ${averageDays(record.promedio_dias)}</span>
            </div>
          </div>`;
        }).join("")
        : '<div class="empty">No hay eficiencia por área para estos filtros.</div>';
    }

    function caseBreakdownCountCell(value, label, state = "total", className = "") {
      const classAttribute = className ? ` class="${escapeHtml(className)}"` : "";
      return `<td${classAttribute} data-case-breakdown data-breakdown-state="${state}" role="button" tabindex="0"
        aria-label="${escapeHtml(label)}">${numberFormat.format(value ?? 0)}</td>`;
    }

    function renderMotiveBreakdown(summary, totals) {
      const percentFormat = new Intl.NumberFormat("es-PE", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      });
      const dayFormat = new Intl.NumberFormat("es-PE", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      });
      const percent = (value) => value === null || value === undefined
        ? "—"
        : `${percentFormat.format(value)}%`;
      const days = (value) => value === null || value === undefined
        ? "—"
        : dayFormat.format(value);
      const tables = [
        ["CONSULTA", "area-consult-motives-body", "area-consult-motives-foot", "consultas"],
        ["RECLAMO", "area-complaint-motives-body", "area-complaint-motives-foot", "reclamos"]
      ];

      tables.forEach(([caseType, bodyId, footId, label]) => {
        const body = document.getElementById(bodyId);
        const rows = summary && summary[caseType] || [];
        const total = totals && totals[caseType] || {};
        body.innerHTML = rows.length
          ? rows.map((record) => {
            const recordLabel = `${caseType}, motivo ${record.motivo}${record.nivel === "submotivo" ? `, submotivo ${record.submotivo}` : ""}`;
            return `<tr class="${record.nivel === "motivo" ? "motive-breakdown-parent" : ""}"
                data-breakdown-kind="motivo"
                data-case-type="${escapeHtml(caseType)}"
                data-breakdown-level="${escapeHtml(record.nivel)}"
                data-motive="${escapeHtml(record.motivo)}"
                data-submotive="${escapeHtml(record.submotivo)}">
                <td class="${record.nivel === "submotivo" ? "motive-breakdown-submotive" : ""}">${escapeHtml(record.nivel === "motivo" ? record.motivo : record.submotivo)}</td>
                ${caseBreakdownCountCell(record.total, `Ver ${record.total} casos de ${recordLabel}`, "total")}
                <td>${percent(record.porcentaje_total)}</td>
                <td>${days(record.promedio_dias)}</td>
                ${caseBreakdownCountCell(record.solucionados, `Ver ${record.solucionados} casos solucionados de ${recordLabel}`, "solucionados")}
                <td>${percent(record.porcentaje_solucionados)}</td>
                <td>${days(record.promedio_dias_solucionados)}</td>
                ${caseBreakdownCountCell(record.no_solucionados, `Ver ${record.no_solucionados} casos no solucionados de ${recordLabel}`, "no_solucionados")}
                <td>${percent(record.porcentaje_no_solucionados)}</td>
                <td>${days(record.promedio_dias_no_solucionados)}</td>
              </tr>`;
          }).join("")
          : `<tr><td class="empty" colspan="10">No hay casos de ${label} con los filtros seleccionados.</td></tr>`;
        document.getElementById(footId).innerHTML = `<tr data-breakdown-kind="motivo"
          data-breakdown-total="true" data-case-type="${escapeHtml(caseType)}">
          <td>TOTAL GENERAL</td>
          ${caseBreakdownCountCell(total.total || 0, `Ver ${total.total || 0} casos de ${caseType}`, "total")}
          <td>${percent(total.porcentaje_total)}</td>
          <td>${days(total.promedio_dias)}</td>
          ${caseBreakdownCountCell(total.solucionados || 0, `Ver ${total.solucionados || 0} casos solucionados de ${caseType}`, "solucionados")}
          <td>${percent(total.porcentaje_solucionados)}</td>
          <td>${days(total.promedio_dias_solucionados)}</td>
          ${caseBreakdownCountCell(total.no_solucionados || 0, `Ver ${total.no_solucionados || 0} casos no solucionados de ${caseType}`, "no_solucionados")}
          <td>${percent(total.porcentaje_no_solucionados)}</td>
          <td>${days(total.promedio_dias_no_solucionados)}</td>
        </tr>`;
      });
    }

    function renderTypeCategoryTable(summary, bodyId, footId, categoryLabel, filterId) {
      const body = document.getElementById(bodyId);
      const caseTypes = [
        ["CONSULTA", "consulta"],
        ["RECLAMO", "reclamo"]
      ];
      body.innerHTML = caseTypes.map(([caseType, style]) => {
        const group = summary && summary[caseType] || {};
        const records = group.registros || [];
        return `<tr class="comparison-type-${style}"
            data-breakdown-kind="${filterId}" data-breakdown-group="true"
            data-case-type="${caseType}">
            <td>${caseType}</td>
            ${caseBreakdownCountCell(group.total || 0, `Ver ${group.total || 0} casos de ${caseType}`)}
          </tr>
          ${records.map((record) => `<tr class="comparison-category-${style}"
            data-breakdown-kind="${filterId}" data-case-type="${caseType}"
            data-category-value="${escapeHtml(record.nombre)}">
            <td>${escapeHtml(record.nombre)}</td>
            ${caseBreakdownCountCell(record.total || 0, `Ver ${record.total || 0} casos de ${caseType} para ${record.nombre}`)}
          </tr>`).join("")}`;
      }).join("") || `<tr><td colspan="2" class="empty">No hay datos de ${categoryLabel}.</td></tr>`;
      document.getElementById(footId).innerHTML = `<tr data-breakdown-kind="${filterId}"
        data-breakdown-total="true">
        <td>TOTAL</td>
        ${caseBreakdownCountCell(summary && summary.total || 0, `Ver ${summary && summary.total || 0} casos de ${categoryLabel}`)}
      </tr>`;
    }

    function renderAdvisorDirectory(result) {
      const monthData = result.seguimiento_mensual_asesores;
      const periodData = result.resumen_asesores || monthData;
      const periodRecords = periodData.registros || [];
      const periodDataAvailable = Boolean(result.resumen_asesores);
      const timeDataAvailable = periodRecords.length > 0 && periodRecords.every((record) =>
        Object.prototype.hasOwnProperty.call(record, "en_plazo")
      );
      const areas = new Map();
      const getAdvisor = (area, name) => {
        const areaName = area || "SIN ÁREA";
        const advisorName = name || "SIN ASESOR";
        if (!areas.has(areaName)) areas.set(areaName, new Map());
        const advisors = areas.get(areaName);
        if (!advisors.has(advisorName)) {
          advisors.set(advisorName, {
            total: 0,
            enPlazo: 0,
            tiempoDisponible: false,
            solucionados: 0,
            noSolucionados: 0
          });
        }
        return advisors.get(advisorName);
      };

      for (const record of result.directorio_asesores || []) {
        getAdvisor(record.area, record.asesor);
      }
      for (const record of periodRecords) {
        const advisor = getAdvisor(record.area, record.asesor);
        advisor.total += Number(record.total) || 0;
        if (Object.prototype.hasOwnProperty.call(record, "en_plazo")) {
          advisor.enPlazo += Number(record.en_plazo) || 0;
          advisor.tiempoDisponible = true;
        }
        advisor.solucionados += Number(record.solucionados) || 0;
        advisor.noSolucionados += Number(record.no_solucionados) || 0;
      }

      const mappedAdvisors = new Set(
        [...areas.values()].flatMap((advisors) => [...advisors.keys()])
      );
      for (const advisor of result.opciones.gestores || []) {
        if (!mappedAdvisors.has(advisor)) getAdvisor("SIN ÁREA", advisor);
      }

      const selectedArea = document.getElementById("area").value;
      const selectedAdvisor = document.getElementById("gestor").value;
      const rows = [...areas.entries()]
        .filter(([area]) => !selectedArea || area === selectedArea)
        .map(([area, advisors]) => [
          area,
          [...advisors.entries()]
            .filter(([name]) => !selectedAdvisor || name === selectedAdvisor)
            .sort(([left], [right]) => left.localeCompare(right, "es"))
        ])
        .filter(([, advisors]) => advisors.length)
        .sort(([left], [right]) => left.localeCompare(right, "es"));
      const body = document.getElementById("advisor-directory-body");
      const advisorPercent = (value, total, decimals = 1) => total
        ? `${(value * 100 / total).toFixed(decimals)}%`
        : "—";
      const timePercent = (advisor) => !advisor.total
        ? "—"
        : advisor.tiempoDisponible
          ? advisorPercent(advisor.enPlazo, advisor.total)
          : "N/D";
      const efficiencyPercent = (advisor) => !advisor.total
        ? "—"
        : advisor.tiempoDisponible
          ? `${((advisor.solucionados + advisor.enPlazo) * 100 / (advisor.total * 2)).toFixed(2)}%`
          : "N/D";

      const summarizeAdvisors = (advisors) => {
        const totals = advisors.reduce((sum, [, advisor]) => ({
          total: sum.total + advisor.total,
          enPlazo: sum.enPlazo + advisor.enPlazo,
          solucionados: sum.solucionados + advisor.solucionados,
          noSolucionados: sum.noSolucionados + advisor.noSolucionados
        }), { total: 0, enPlazo: 0, solucionados: 0, noSolucionados: 0 });
        totals.tiempoDisponible = advisors.every(([, advisor]) =>
          advisor.total === 0 || advisor.tiempoDisponible
        );
        return totals;
      };

      const renderMetrics = (metrics) => metrics.map(([label, value, title = ""]) => `
        <div class="advisor-area-metric" title="${escapeHtml(title)}">
          <span>${label}</span><strong>${value}</strong>
        </div>
      `).join("");

      const renderAdvisorRow = ([name, advisor], areaTotal) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${numberFormat.format(advisor.total)}</td>
          <td>${advisorPercent(advisor.total, areaTotal)}</td>
          <td>${numberFormat.format(advisor.solucionados)}</td>
          <td>${advisorPercent(advisor.solucionados, advisor.total)}</td>
          <td>${numberFormat.format(advisor.noSolucionados)}</td>
          <td>${timePercent(advisor)}</td>
          <td>${efficiencyPercent(advisor)}</td>
        </tr>`;

      const renderArea = ([area, advisors]) => {
        const areaTotals = summarizeAdvisors(advisors);
        return `<article class="advisor-area-card">
          <div class="advisor-area-heading">
            <h3 class="advisor-area-title">${escapeHtml(area)}</h3>
            <p class="advisor-area-count">${numberFormat.format(advisors.length)} ${advisors.length === 1 ? "asesor" : "asesores"}</p>
          </div>
          <div class="advisor-area-summary">
            ${renderMetrics([
              ["Acumulado del período", numberFormat.format(areaTotals.total)],
              ["% solucionados", advisorPercent(areaTotals.solucionados, areaTotals.total)],
              ["% EN PLAZO", !areaTotals.total ? "—" : areaTotals.tiempoDisponible ? advisorPercent(areaTotals.enPlazo, areaTotals.total) : "N/D", "Porcentaje de casos clasificados EN PLAZO (hasta 2 días)."],
              ["Eficiencia general", efficiencyPercent(areaTotals), "50% del porcentaje solucionado + 50% del indicador de tiempo."]
            ])}
          </div>
          <div class="advisor-area-table-wrap">
            <table class="advisor-area-table" aria-label="Eficiencia de asesores en el período para ${escapeHtml(area)}">
              <thead>
                <tr>
                  <th style="width:18%">ASESOR</th>
                  <th style="width:10%">ACUMULADO</th>
                  <th style="width:9%">% DEL ÁREA</th>
                  <th style="width:11%">SOLUCIONADOS</th>
                  <th style="width:11%">% SOLUCIONADOS</th>
                  <th style="width:12%">NO SOLUCIONADOS</th>
                  <th style="width:13%" title="Casos EN PLAZO (hasta 2 días) sobre el total">INDICADOR DE TIEMPO<br><small>% EN PLAZO</small></th>
                  <th style="width:16%" title="50% del porcentaje solucionado + 50% del indicador de tiempo">EFICIENCIA GENERAL<br><small>50% solución + 50% tiempo</small></th>
                </tr>
              </thead>
              <tbody>
                ${advisors.map((advisor) => renderAdvisorRow(advisor, areaTotals.total)).join("")}
              </tbody>
              <tfoot>
                <tr>
                  <td>TOTAL DEL ÁREA</td>
                  <td>${numberFormat.format(areaTotals.total)}</td>
                  <td>${advisorPercent(areaTotals.total, areaTotals.total)}</td>
                  <td>${numberFormat.format(areaTotals.solucionados)}</td>
                  <td>${advisorPercent(areaTotals.solucionados, areaTotals.total)}</td>
                  <td>${numberFormat.format(areaTotals.noSolucionados)}</td>
                  <td>${timePercent(areaTotals)}</td>
                  <td>${efficiencyPercent(areaTotals)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </article>`;
      };

      body.innerHTML = rows.length
        ? rows.map(renderArea).join("")
        : '<p class="empty">No hay asesores para los filtros seleccionados.</p>';

      const advisorNames = new Set(rows.flatMap(([, advisors]) =>
        advisors.map(([name]) => name)
      ));
      const activeAdvisors = new Set(
        rows.flatMap(([, advisors]) =>
          advisors
            .filter(([, advisor]) => advisor.total > 0)
            .map(([name]) => name)
        )
      );
      document.getElementById("advisor-directory-count").textContent =
        `${numberFormat.format(rows.length)} ${rows.length === 1 ? "área" : "áreas"} · ${numberFormat.format(advisorNames.size)} ${advisorNames.size === 1 ? "asesor" : "asesores"} · ${numberFormat.format(activeAdvisors.size)} ${activeAdvisors.size === 1 ? "asesor activo" : "asesores activos"}`;
      const periodStart = periodData.desde || (result.periodo && result.periodo.desde);
      const periodEnd = periodData.hasta || (result.periodo && result.periodo.hasta);
      const periodLabel = periodStart && periodEnd
        ? `${formatDate(periodStart)} al ${formatDate(periodEnd)}`
        : "sin casos en el período";
      const restartNotice = periodRecords.length && (!periodDataAvailable || !timeDataAvailable)
        ? " Reinicia el servidor para cargar los datos de eficiencia."
        : "";
      document.getElementById("advisor-directory-subtitle").textContent =
        `Período: ${periodLabel} · Indicador de tiempo: casos EN PLAZO (hasta 2 días). Eficiencia general = 50% solucionados + 50% en plazo.${restartNotice}`;
    }


    function advisorMonthWeekCount(monthData) {
      if (!monthData || !monthData.desde) return 0;
      const monthDate = new Date(`${monthData.desde}T00:00:00Z`);
      const monthDays = new Date(Date.UTC(
        monthDate.getUTCFullYear(),
        monthDate.getUTCMonth() + 1,
        0
      )).getUTCDate();
      const firstWeekday = (monthDate.getUTCDay() + 6) % 7;
      return Math.ceil((firstWeekday + monthDays) / 7);
    }

    function hasAdvisorMonthWeeks(monthData) {
      const records = monthData && monthData.registros || [];
      const weekCount = advisorMonthWeekCount(monthData);
      return records.length > 0 && records.every((record) =>
        Array.isArray(record.semanas) && record.semanas.length === weekCount
      );
    }

    async function loadAdvisorMonthWeeks(monthData, signal) {
      const monthStart = monthData.desde;
      const monthEnd = monthData.hasta;
      const weekCount = advisorMonthWeekCount(monthData);
      const params = dashboardParams();
      const filterStart = params.get("desde");
      const filterEnd = params.get("hasta");
      const startDate = new Date(`${monthStart}T00:00:00Z`);
      const endDate = new Date(`${monthEnd}T00:00:00Z`);
      const firstWeekday = (startDate.getUTCDay() + 6) % 7;
      const weekStart = new Date(startDate);
      weekStart.setUTCDate(weekStart.getUTCDate() - firstWeekday);
      const periods = [];

      for (const cursor = new Date(weekStart); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
        const periodStart = new Date(cursor);
        const periodEnd = new Date(cursor);
        periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);
        const start = [
          monthStart,
          periodStart.toISOString().slice(0, 10),
          filterStart
        ].filter(Boolean).sort().pop();
        const end = [
          monthEnd,
          periodEnd.toISOString().slice(0, 10),
          filterEnd
        ].filter(Boolean).sort()[0];
        if (start <= end) periods.push({ start, end });
      }

      const reports = await Promise.all(periods.map(async ({ start, end }) => {
        const periodParams = new URLSearchParams(params);
        periodParams.set("desde", start);
        periodParams.set("hasta", end);
        const response = await fetch(`/api/dashboard?${periodParams.toString()}`, { signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "No se pudo cargar el detalle semanal.");
        if (!result.seguimiento_semanal_asesores) {
          throw new Error("El servidor no devolvió el detalle semanal de asesores.");
        }
        return result.seguimiento_semanal_asesores.registros || [];
      }));

      const weeklyTotals = new Map();
      for (const records of reports) {
        for (const record of records) {
          const key = JSON.stringify([record.area, record.asesor]);
          if (!weeklyTotals.has(key)) {
            weeklyTotals.set(key, Array.from({ length: weekCount }, (_, index) => ({
              semana: index + 1,
              solucionados: 0,
              no_solucionados: 0
            })));
          }
          for (const day of record.dias || []) {
            if (day.fecha < monthStart || day.fecha > monthEnd) continue;
            if ((filterStart && day.fecha < filterStart) || (filterEnd && day.fecha > filterEnd)) continue;
            const dayOfMonth = Number(day.fecha.slice(8, 10));
            const weekIndex = Math.floor((dayOfMonth - 1 + firstWeekday) / 7);
            const week = weeklyTotals.get(key)[weekIndex];
            week.solucionados += Number(day.solucionados) || 0;
            week.no_solucionados += Number(day.no_solucionados) || 0;
          }
        }
      }

      return {
        ...monthData,
        registros: (monthData.registros || []).map((record) => ({
          ...record,
          semanas: weeklyTotals.get(JSON.stringify([record.area, record.asesor]))
            || Array.from({ length: weekCount }, (_, index) => ({
              semana: index + 1,
              solucionados: 0,
              no_solucionados: 0
            }))
        }))
      };
    }

    function advisorFlowMonthPeriods(monthData, params) {
      const monthDate = new Date(`${monthData.desde}T00:00:00Z`);
      const monthEndDate = new Date(`${monthData.hasta}T00:00:00Z`);
      const firstWeekday = (monthDate.getUTCDay() + 6) % 7;
      const firstWeekStart = new Date(monthDate);
      firstWeekStart.setUTCDate(firstWeekStart.getUTCDate() - firstWeekday);
      const filterStart = params.get("desde");
      const filterEnd = params.get("hasta");

      return Array.from({ length: advisorMonthWeekCount(monthData) }, (_, index) => {
        const start = new Date(firstWeekStart);
        start.setUTCDate(start.getUTCDate() + index * 7);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 6);
        const periodStart = (start < monthDate ? monthDate : start).toISOString().slice(0, 10);
        const periodEnd = (end > monthEndDate ? monthEndDate : end).toISOString().slice(0, 10);
        const queryStart = [periodStart, filterStart].filter(Boolean).sort().pop();
        const queryEnd = [periodEnd, filterEnd].filter(Boolean).sort()[0];

        return {
          start: periodStart,
          end: periodEnd,
          queryStart,
          queryEnd,
          label: `SEMANA ${index + 1}<span class="advisor-week-range">${periodStart.slice(8, 10)}/${periodStart.slice(5, 7)} - ${periodEnd.slice(8, 10)}/${periodEnd.slice(5, 7)}</span>`
        };
      });
    }

    async function loadAdvisorFlowMonthData(flowData, monthData, signal) {
      const params = dashboardParams();
      const periods = advisorFlowMonthPeriods(monthData, params);
      const activePeriods = periods.filter((period) => period.queryStart <= period.queryEnd);
      if (!activePeriods.length) {
        return {
          ...flowData,
          periodos_mensuales: periods,
          recibidos_no_derivados_mes: [],
          recibidos_derivados_mes: [],
          salientes_mes: []
        };
      }

      const periodParams = new URLSearchParams(params);
      periodParams.set("desde", activePeriods[0].queryStart);
      periodParams.set("hasta", activePeriods[activePeriods.length - 1].queryEnd);
      periodParams.set("flujo_mensual", "true");
      const response = await fetch(`/api/dashboard?${periodParams.toString()}`, { signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "No se pudo cargar el seguimiento mensual.");
      if (!result.flujo_semanal_asesores) {
        throw new Error("El servidor no devolvió el seguimiento de asesores.");
      }

      const monthFlow = result.flujo_semanal_asesores;
      const dailyRecordsForPeriod = (records, period) => records.map((record) => ({
        ...record,
        dias: (record.dias || []).filter((day) =>
          day.fecha >= period.queryStart && day.fecha <= period.queryEnd
        )
      }));
      const reports = periods.map((period, periodIndex) => ({
        recibidos_no_derivados: dailyRecordsForPeriod(
          monthFlow.recibidos_no_derivados || [],
          period
        ).map((record) => ({
          ...record,
          semanal: periodIndex === 0 ? record.semanal : {}
        })),
        recibidos_derivados: dailyRecordsForPeriod(
          monthFlow.recibidos_derivados || [],
          period
        ).map((record) => ({
          ...record,
          derivaciones: periodIndex === 0 ? record.derivaciones : []
        })),
        salientes: dailyRecordsForPeriod(
          monthFlow.salientes || [],
          period
        ).map((record) => ({
          ...record,
          derivaciones: periodIndex === 0 ? record.derivaciones : []
        }))
      }));

      const nonderivedRecords = new Map();
      const derivedRecords = new Map();
      const outgoingRecords = new Map();
      for (const [periodIndex, report] of reports.entries()) {
        for (const record of report.recibidos_no_derivados || []) {
          const key = JSON.stringify([record.area, record.asesor]);
          if (!nonderivedRecords.has(key)) {
            nonderivedRecords.set(key, {
              area: record.area,
              asesor: record.asesor,
              dias: periods.map((period) => ({ fecha: period.start, total: 0 })),
              semanal: { cerrado: 0, pendiente: 0, sin_condicion: 0 }
            });
          }
          const monthlyRecord = nonderivedRecords.get(key);
          monthlyRecord.dias[periodIndex].total += (record.dias || []).reduce(
            (total, day) => total + (Number(day.total) || 0),
            0
          );
          for (const status of ["cerrado", "pendiente", "sin_condicion"]) {
            monthlyRecord.semanal[status] += Number(record.semanal && record.semanal[status]) || 0;
          }
        }

        for (const record of report.recibidos_derivados || []) {
          const key = JSON.stringify([record.area, record.asesor]);
          if (!derivedRecords.has(key)) {
            derivedRecords.set(key, {
              record: {
                area: record.area,
                asesor: record.asesor,
                dias: periods.map((period) => ({ fecha: period.start, total: 0 }))
              },
              transfers: new Map()
            });
          }
          const receiver = derivedRecords.get(key);
          receiver.record.dias[periodIndex].total += (record.dias || []).reduce(
            (total, day) => total + (Number(day.total) || 0),
            0
          );
          for (const transfer of record.derivaciones || []) {
            const transferKey = JSON.stringify([transfer.area_emisora, transfer.asesor_emisor]);
            if (!receiver.transfers.has(transferKey)) {
              receiver.transfers.set(transferKey, {
                area_emisora: transfer.area_emisora,
                asesor_emisor: transfer.asesor_emisor,
                total: 0,
                atendido: 0,
                pendiente: 0,
                sin_condicion: 0
              });
            }
            const monthlyTransfer = receiver.transfers.get(transferKey);
            for (const field of ["total", "atendido", "pendiente", "sin_condicion"]) {
              monthlyTransfer[field] += Number(transfer[field]) || 0;
            }
          }

          for (const record of report.salientes || []) {
            const key = JSON.stringify([record.area, record.asesor]);
            if (!outgoingRecords.has(key)) {
              outgoingRecords.set(key, {
                record: {
                  area: record.area,
                  asesor: record.asesor,
                  dias: periods.map((period) => ({ fecha: period.start, total: 0 }))
                },
                transfers: new Map()
              });
            }
            const sender = outgoingRecords.get(key);
            sender.record.dias[periodIndex].total += (record.dias || []).reduce(
              (total, day) => total + (Number(day.total) || 0),
              0
            );
            for (const transfer of record.derivaciones || []) {
              const transferKey = JSON.stringify([transfer.area_receptora, transfer.receptor]);
              if (!sender.transfers.has(transferKey)) {
                sender.transfers.set(transferKey, {
                  area_receptora: transfer.area_receptora,
                  receptor: transfer.receptor,
                  total: 0,
                  atendido: 0,
                  pendiente: 0,
                  sin_condicion: 0
                });
              }
              const monthlyTransfer = sender.transfers.get(transferKey);
              for (const field of ["total", "atendido", "pendiente", "sin_condicion"]) {
                monthlyTransfer[field] += Number(transfer[field]) || 0;
              }
            }
          }
        }
      }

      const sortRecords = (left, right) =>
        String(left.area).localeCompare(String(right.area), "es")
        || String(left.asesor).localeCompare(String(right.asesor), "es");
      return {
        ...flowData,
        periodos_mensuales: periods,
        recibidos_no_derivados_mes: [...nonderivedRecords.values()].sort(sortRecords),
        recibidos_derivados_mes: [...derivedRecords.values()].map(({ record, transfers }) => ({
          ...record,
          derivaciones: [...transfers.values()].sort((left, right) =>
            String(left.area_emisora).localeCompare(String(right.area_emisora), "es")
            || String(left.asesor_emisor).localeCompare(String(right.asesor_emisor), "es")
          )
        })).sort(sortRecords),
        salientes_mes: [...outgoingRecords.values()].map(({ record, transfers }) => ({
          ...record,
          derivaciones: [...transfers.values()].sort((left, right) =>
            String(left.area_receptora).localeCompare(String(right.area_receptora), "es")
            || String(left.receptor).localeCompare(String(right.receptor), "es")
          )
        })).sort(sortRecords)
      };
    }

    function hasAdvisorFlowMonthData(flowData, monthData) {
      return Boolean(
        flowData
        && Array.isArray(flowData.periodos_mensuales)
        && flowData.periodos_mensuales.length === advisorMonthWeekCount(monthData)
        && Array.isArray(flowData.recibidos_no_derivados_mes)
        && Array.isArray(flowData.recibidos_derivados_mes)
        && Array.isArray(flowData.salientes_mes)
      );
    }

    function renderAdvisorMonth(monthData) {
      const table = document.getElementById("advisor-week-table");
      if (!monthData || !monthData.desde || !monthData.hasta) {
        table.innerHTML = '<tbody><tr><td class="empty">No hay datos mensuales disponibles.</td></tr></tbody>';
        return;
      }

      const monthDate = new Date(`${monthData.desde}T00:00:00Z`);
      const firstWeekday = (monthDate.getUTCDay() + 6) % 7;
      const monthName = monthNameFormat.format(monthDate).toLocaleUpperCase("es-PE");
      const monthYear = String(monthDate.getUTCFullYear());
      const monthHeading = `ACUMULADO | ${monthName}`;
      const firstWeekStart = new Date(monthDate);
      firstWeekStart.setUTCDate(firstWeekStart.getUTCDate() - firstWeekday);
      const monthEnd = new Date(Date.UTC(
        monthDate.getUTCFullYear(),
        monthDate.getUTCMonth() + 1,
        0
      ));
      const weekPeriods = Array.from({ length: advisorMonthWeekCount(monthData) }, (_, index) => {
        const start = new Date(firstWeekStart);
        start.setUTCDate(start.getUTCDate() + index * 7);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 6);
        const periodStart = start < monthDate ? monthDate : start;
        const periodEnd = end > monthEnd ? monthEnd : end;
        return {
          number: index + 1,
          start: periodStart.toISOString().slice(0, 10),
          end: periodEnd.toISOString().slice(0, 10)
        };
      });
      const monthReport = {
        reportStart: monthData.desde,
        reportEnd: monthData.hasta
      };
      const sourceRecords = monthData.registros || [];
      const renderWeekValues = (record, filters = {}) => weekPeriods.map((week) => {
        const values = record.semanas[week.number - 1];
        const reportPeriod = {
          reportStart: week.start,
          reportEnd: week.end,
          ...filters
        };
        const total = values.solucionados + values.no_solucionados;
        return `${caseNumberCell(values.solucionados, {
          ...reportPeriod,
          reportState: "seguimiento_solucionado"
        }, { detail: "seguimiento_mensual" })}
          ${caseNumberCell(values.no_solucionados, {
            ...reportPeriod,
            reportState: "seguimiento_no_solucionado"
          }, { detail: "seguimiento_mensual" })}
          ${caseNumberCell(total, {
            ...reportPeriod,
            reportState: "seguimiento_total"
          }, { detail: "seguimiento_mensual" })}`;
      }).join("");
      const renderMonthValues = (record, filters = {}) => `
        ${caseNumberCell(record.solucionados, {
          ...monthReport, ...filters, reportState: "seguimiento_solucionado"
        }, { detail: "seguimiento_mensual" })}
        ${caseNumberCell(record.no_solucionados, {
          ...monthReport, ...filters, reportState: "seguimiento_no_solucionado"
        }, { detail: "seguimiento_mensual" })}
        ${caseNumberCell(record.total, {
          ...monthReport, ...filters, reportState: "seguimiento_total"
        }, { detail: "seguimiento_mensual" })}`;
      const columnCount = 1 + weekPeriods.length * 3 + 3;
      const weeklyColumnWidth = (65 / (weekPeriods.length * 3)).toFixed(4);
      const columns = `<colgroup>
        <col style="width:15%">
        ${weekPeriods.map(() => `<col style="width:${weeklyColumnWidth}%"><col style="width:${weeklyColumnWidth}%"><col style="width:${weeklyColumnWidth}%">`).join("")}
        <col style="width:6.6667%"><col style="width:6.6667%"><col style="width:6.6667%">
      </colgroup>`;
      const header = `<thead>
        <tr><th rowspan="2" scope="col">ÁREA / ASESOR</th>
          ${weekPeriods.map((week) => `<th colspan="3">SEMANA ${week.number}<span class="advisor-week-range">${week.start.slice(8, 10)}/${week.start.slice(5, 7)} - ${week.end.slice(8, 10)}/${week.end.slice(5, 7)}</span></th>`).join("")}
          <th colspan="3"><span>${monthHeading}</span><span class="advisor-month-year">${monthYear}</span></th>
        </tr>
        <tr>${weekPeriods.map(() => '<th>Soluc.</th><th>No soluc.</th><th>Total</th>').join("")}
          <th>Soluc.</th><th>No soluc.</th><th>Total</th>
        </tr>
      </thead>`;
      const records = sourceRecords.map((record) => ({
        ...record,
        semanas: weekPeriods.map((week) => {
          const totals = (record.semanas || []).find((item) => item.semana === week.number);
          return {
            solucionados: Number(totals && totals.solucionados) || 0,
            no_solucionados: Number(totals && totals.no_solucionados) || 0
          };
        }),
        solucionados: Number(record.solucionados) || 0,
        no_solucionados: Number(record.no_solucionados) || 0,
        total: Number(record.total) || 0
      })).sort((left, right) =>
        String(left.area).localeCompare(String(right.area), "es")
        || String(left.asesor).localeCompare(String(right.asesor), "es")
      );
      if (!records.length) {
        table.innerHTML = `${columns}${header}
          <tbody><tr><td class="empty" colspan="${columnCount}">No hay casos para el mes seleccionado con los filtros activos.</td></tr></tbody>`;
        return;
      }

      const makeTotals = () => ({
        semanas: weekPeriods.map(() => ({ solucionados: 0, no_solucionados: 0 })),
        solucionados: 0,
        no_solucionados: 0,
        total: 0
      });
      const addTotals = (totals, record) => {
        record.semanas.forEach((week, index) => {
          totals.semanas[index].solucionados += week.solucionados;
          totals.semanas[index].no_solucionados += week.no_solucionados;
        });
        totals.solucionados += record.solucionados;
        totals.no_solucionados += record.no_solucionados;
        totals.total += record.total;
        return totals;
      };
      const byArea = new Map();
      for (const record of records) {
        if (!byArea.has(record.area)) byArea.set(record.area, []);
        byArea.get(record.area).push(record);
      }
      const grandTotal = makeTotals();
      const body = `${[...byArea.entries()].map(([area, advisors]) => {
        const areaTotal = advisors.reduce(addTotals, makeTotals());
        addTotals(grandTotal, areaTotal);
        const advisorRows = advisors.map((record) => {
          const filters = { area, asesorReporte: record.asesor };
          return `<tr ${caseRowAttributes("seguimiento_semanal", filters)}>
            <th class="advisor-name" scope="row">${escapeHtml(record.asesor)}</th>
            ${renderWeekValues(record, filters)}${renderMonthValues(record, filters)}
          </tr>`;
        }).join("");
        const filters = { area };
        return `<tr class="advisor-area-row" ${caseRowAttributes("seguimiento_semanal", filters)}>
          <th scope="row">${escapeHtml(area)}</th>
          ${renderWeekValues(areaTotal, filters)}${renderMonthValues(areaTotal, filters)}
        </tr>${advisorRows}`;
      }).join("")}`;
      table.innerHTML = `${columns}${header}
        <tbody>${body}</tbody>
        <tfoot><tr ${caseRowAttributes("seguimiento_semanal")}><th scope="row">TOTAL GENERAL</th>
          ${renderWeekValues(grandTotal)}${renderMonthValues(grandTotal)}
        </tr></tfoot>`;
    }

    function renderAdvisorWeek(weekData, monthData) {
      const table = document.getElementById("advisor-week-table");
      const subtitle = document.getElementById("advisor-week-subtitle");
      const title = document.getElementById("advisor-week-title");
      const modeToggle = document.getElementById("advisor-week-mode-toggle");
      const downloadButton = document.getElementById("advisor-week-download");
      latestAdvisorWeekData = weekData;
      latestAdvisorMonthData = monthData;
      const isMonthly = advisorWeekMode === "monthly";
      title.textContent = isMonthly
        ? "Seguimiento MENSUAL por asesor y área"
        : "Seguimiento semanal por asesor y área";
      modeToggle.checked = isMonthly;
      modeToggle.setAttribute("aria-checked", String(isMonthly));
      modeToggle.setAttribute("aria-label", isMonthly
        ? "Cambiar a vista semanal"
        : "Cambiar a vista mensual");
      downloadButton.dataset.exportName = isMonthly
        ? "seguimiento-mensual-por-asesor-y-area.png"
        : "seguimiento-semanal-y-acumulado-mensual.png";
      downloadButton.title = isMonthly
        ? "Descargar seguimiento mensual por asesor y área como PNG"
        : "Descargar seguimiento semanal y acumulado mensual como PNG";
      downloadButton.setAttribute("aria-label", downloadButton.title);
      const monthDate = new Date(`${monthData.desde}T00:00:00Z`);
      const monthName = monthNameFormat.format(monthDate).toLocaleUpperCase("es-PE");
      const monthYear = String(monthDate.getUTCFullYear());
      const monthHeading = `ACUMULADO | ${monthName}`;
      const weekDays = weekData.dias || [];
      const dateLabel = (value) => dateFormat.format(new Date(`${value}T00:00:00Z`));
      const monthWeekStart = new Date(monthDate);
      monthWeekStart.setUTCDate(monthWeekStart.getUTCDate() - ((monthDate.getUTCDay() + 6) % 7));
      const selectedWeekStart = new Date(`${weekData.desde}T00:00:00Z`);
      selectedWeekStart.setUTCDate(
        selectedWeekStart.getUTCDate() - ((selectedWeekStart.getUTCDay() + 6) % 7)
      );
      const monthWeekNumber = Math.floor(
        (selectedWeekStart - monthWeekStart) / (7 * 24 * 60 * 60 * 1000)
      ) + 1;
      const periodLabel = document.getElementById("advisor-week-period-label");
      periodLabel.hidden = isMonthly;
      periodLabel.textContent = isMonthly
        ? ""
        : `SEMANA ${monthWeekNumber} DE ${monthName} ${monthYear} · ${dateLabel(weekData.desde)} - ${dateLabel(weekData.hasta)}`;
      subtitle.textContent = `${dateLabel(weekData.desde)} - ${dateLabel(weekData.hasta)} · ${monthHeading} ${monthYear} · Según los filtros activos`;
      if (isMonthly) {
        renderAdvisorMonth(monthData);
        return;
      }

      const advisorRows = new Map();
      const getAdvisorRow = (area, advisor) => {
        const key = JSON.stringify([area, advisor]);
        if (!advisorRows.has(key)) {
          advisorRows.set(key, {
            area,
            asesor: advisor,
            dias: weekDays.map(() => ({ solucionados: 0, no_solucionados: 0 })),
            mes: { solucionados: 0, no_solucionados: 0, total: 0 }
          });
        }
        return advisorRows.get(key);
      };
      for (const record of weekData.registros || []) {
        const row = getAdvisorRow(record.area, record.asesor);
        for (const day of record.dias) {
          const index = weekDays.indexOf(day.fecha);
          if (index < 0) continue;
          row.dias[index].solucionados = Number(day.solucionados) || 0;
          row.dias[index].no_solucionados = Number(day.no_solucionados) || 0;
        }
      }
      for (const record of monthData.registros || []) {
        const row = getAdvisorRow(record.area, record.asesor);
        row.mes = {
          solucionados: Number(record.solucionados) || 0,
          no_solucionados: Number(record.no_solucionados) || 0,
          total: Number(record.total) || 0
        };
      }

      const records = [...advisorRows.values()].sort((left, right) =>
        left.area.localeCompare(right.area, "es") || left.asesor.localeCompare(right.asesor, "es")
      );
      const firstColumnWidth = 14;
      const weeklyTotalWidth = 4.5;
      const monthlyColumnWidth = 7.3;
      const dailyColumnWidth = (
        100 - firstColumnWidth - weeklyTotalWidth * 3 - monthlyColumnWidth * 3
      ) / (weekDays.length * 2);
      const columns = `<colgroup>
        <col style="width:${firstColumnWidth}%">
        ${weekDays.map(() => `<col style="width:${dailyColumnWidth}%"><col style="width:${dailyColumnWidth}%">`).join("")}
        ${Array.from({ length: 3 }, () => `<col style="width:${weeklyTotalWidth}%">`).join("")}
        ${Array.from({ length: 3 }, () => `<col style="width:${monthlyColumnWidth}%">`).join("")}
      </colgroup>`;
      const dayHeaders = weekDays.map((day) =>
        `<th class="advisor-day-heading" colspan="2">${weekdayDateFormat.format(new Date(`${day}T00:00:00Z`)).replace(".", "")}</th>`
      ).join("");
      const header = `<thead>
        <tr><th rowspan="2" scope="col">ÁREA / ASESOR</th>${dayHeaders}
          <th colspan="3">TOTAL SEMANA</th>
          <th colspan="3"><span>${monthHeading}</span><span class="advisor-month-year">${monthYear}</span></th>
        </tr>
        <tr>${weekDays.map(() => '<th class="advisor-day-status">Soluc.</th><th class="advisor-day-status">No soluc.</th>').join("")}
          <th>Soluc.</th><th>No soluc.</th><th>Total</th>
          <th>Soluc.</th><th>No soluc.</th><th>Total</th>
        </tr>
      </thead>`;
      const reportWeek = { reportStart: weekData.desde, reportEnd: weekData.hasta };
      const reportMonth = { reportStart: monthData.desde, reportEnd: monthData.hasta };
      const sumWeek = (days) => days.reduce((totals, day) => ({
        solucionados: totals.solucionados + day.solucionados,
        no_solucionados: totals.no_solucionados + day.no_solucionados
      }), { solucionados: 0, no_solucionados: 0 });
      const renderWeekValues = (row, filters = {}) => {
        const dayCells = row.dias.map((day, index) => {
          const dayFilter = { ...reportWeek, ...filters, reportDay: weekDays[index] };
          return `${caseNumberCell(day.solucionados, {
            ...dayFilter, reportState: "seguimiento_solucionado"
          })}
          ${caseNumberCell(day.no_solucionados, {
            ...dayFilter, reportState: "seguimiento_no_solucionado"
          })}`;
        }).join("");
        const totals = sumWeek(row.dias);
        const total = totals.solucionados + totals.no_solucionados;
        return `${dayCells}
          ${caseNumberCell(totals.solucionados, {
            ...reportWeek, ...filters, reportState: "seguimiento_solucionado"
          })}
          ${caseNumberCell(totals.no_solucionados, {
            ...reportWeek, ...filters, reportState: "seguimiento_no_solucionado"
          })}
          ${caseNumberCell(total, {
            ...reportWeek, ...filters, reportState: "seguimiento_total"
          })}`;
      };
      const renderMonthValues = (totals, filters = {}) => `
        ${caseNumberCell(totals.solucionados, {
          ...reportMonth, ...filters, reportState: "seguimiento_solucionado"
        }, { detail: "seguimiento_mensual" })}
        ${caseNumberCell(totals.no_solucionados, {
          ...reportMonth, ...filters, reportState: "seguimiento_no_solucionado"
        }, { detail: "seguimiento_mensual" })}
        ${caseNumberCell(totals.total, {
          ...reportMonth, ...filters, reportState: "seguimiento_total"
        }, { detail: "seguimiento_mensual" })}`;
      const renderReportValues = (row, filters = {}) =>
        `${renderWeekValues(row, filters)}${renderMonthValues(row.mes, filters)}`;
      const columnCount = 1 + weekDays.length * 2 + 6;

      if (!records.length) {
        table.innerHTML = `${columns}${header}
          <tbody><tr><td class="empty" colspan="${columnCount}">No hay casos para la semana ni para ${monthName} ${monthYear} con los filtros seleccionados.</td></tr></tbody>`;
        return;
      }

      const byArea = new Map();
      for (const record of records) {
        if (!byArea.has(record.area)) byArea.set(record.area, []);
        byArea.get(record.area).push(record);
      }
      const grandTotal = {
        dias: weekDays.map(() => ({ solucionados: 0, no_solucionados: 0 })),
        mes: { solucionados: 0, no_solucionados: 0, total: 0 }
      };
      const body = [...byArea.entries()].map(([area, areaRecords]) => {
        const areaTotal = {
          dias: weekDays.map((_, index) => areaRecords.reduce((totals, record) => ({
            solucionados: totals.solucionados + record.dias[index].solucionados,
            no_solucionados: totals.no_solucionados + record.dias[index].no_solucionados
          }), { solucionados: 0, no_solucionados: 0 })),
          mes: areaRecords.reduce((totals, record) => ({
            solucionados: totals.solucionados + record.mes.solucionados,
            no_solucionados: totals.no_solucionados + record.mes.no_solucionados,
            total: totals.total + record.mes.total
          }), { solucionados: 0, no_solucionados: 0, total: 0 })
        };
        areaTotal.dias.forEach((day, index) => {
          grandTotal.dias[index].solucionados += day.solucionados;
          grandTotal.dias[index].no_solucionados += day.no_solucionados;
        });
        grandTotal.mes.solucionados += areaTotal.mes.solucionados;
        grandTotal.mes.no_solucionados += areaTotal.mes.no_solucionados;
        grandTotal.mes.total += areaTotal.mes.total;

        const advisorRowsHtml = areaRecords.map((record) => {
          const filters = { area, asesorReporte: record.asesor };
          return `<tr ${caseRowAttributes("seguimiento_semanal", filters)}>
            <th class="advisor-name" scope="row">${escapeHtml(record.asesor)}</th>${renderReportValues(record, filters)}</tr>`;
        }).join("");
        return `<tr class="advisor-area-row" ${caseRowAttributes("seguimiento_semanal", { area })}>
          <th scope="row">${escapeHtml(area)}</th>${renderReportValues(areaTotal, { area })}
        </tr>${advisorRowsHtml}`;
      }).join("");

      table.innerHTML = `${columns}${header}
        <tbody>${body}</tbody>
        <tfoot><tr ${caseRowAttributes("seguimiento_semanal")}><th scope="row">TOTAL GENERAL</th>${renderReportValues(grandTotal)}</tr></tfoot>`;
    }

    function renderAdvisorFlowTable(tableId, records, days, statuses, detail, view = {}) {
      const table = document.getElementById(tableId);
      table.classList.add("advisor-flow-table-nonderived");
      const periods = view.periods || [];
      const isMonthly = Boolean(view.monthly);
      const dayHeaders = days.map((day, index) =>
        `<th class="advisor-flow-day-heading">${isMonthly
          ? periods[index].label
          : weekdayDateFormat.format(new Date(`${day}T00:00:00Z`)).replace(".", "")}</th>`
      ).join("");
      const statusHeaders = statuses.map(([, label]) => `<th>${label}</th>`).join("");
      const firstColumnWidth = 12;
      const totalColumnWidth = 8;
      const statusColumnWidth = 8;
      const dailyColumnWidth = (
        100 - firstColumnWidth - totalColumnWidth - statuses.length * statusColumnWidth
      ) / days.length;
      const columns = `<colgroup>
        <col style="width:${firstColumnWidth}%">
        ${days.map(() => `<col style="width:${dailyColumnWidth}%">`).join("")}
        <col style="width:${totalColumnWidth}%">
        ${statuses.map(() => `<col style="width:${statusColumnWidth}%">`).join("")}
      </colgroup>`;
      const header = `<thead>
        <tr><th rowspan="2" scope="col">ÁREA / ASESOR</th>${dayHeaders}
          <th rowspan="2" scope="col">${isMonthly ? "TOTAL MES" : "TOTAL"}</th>
          <th colspan="${statuses.length}">${isMonthly ? "MENSUAL" : "SEMANAL"}</th></tr>
        <tr>${days.map(() => '<th class="advisor-flow-day-status">CASOS</th>').join("")}${statusHeaders}</tr>
      </thead>`;
      const columnCount = 1 + days.length + 1 + statuses.length;

      if (!records.length) {
        table.innerHTML = `${columns}${header}<tbody><tr><td class="empty" colspan="${columnCount}">Sin casos para ${isMonthly ? "el mes" : "esta semana"} con los filtros seleccionados.</td></tr></tbody>`;
        return;
      }

      const emptyTotals = () => ({
        dias: days.map(() => 0),
        semanal: Object.fromEntries(statuses.map(([key]) => [key, 0]))
      });
      const addTotals = (totals, record) => {
        record.dias.forEach((day, index) => {
          totals.dias[index] += day.total;
        });
        for (const [key] of statuses) totals.semanal[key] += record.semanal[key] || 0;
        return totals;
      };
      const renderValues = (totals, reportFilters) => {
        const dailyTotal = totals.dias.reduce((sum, value) => sum + value, 0);
        const reportWindow = isMonthly
          ? { reportStart: periods[0].start, reportEnd: periods[periods.length - 1].end }
          : { reportStart: days[0], reportEnd: days[days.length - 1] };
        const statusValues = statuses.map(([key]) =>
          caseNumberCell(totals.semanal[key], { ...reportWindow, ...reportFilters, reportState: key })
        ).join("");
        return `${totals.dias.map((value, index) => {
          const periodFilter = isMonthly
            ? { reportStart: periods[index].start, reportEnd: periods[index].end }
            : { ...reportWindow, reportDay: days[index] };
          return caseNumberCell(value, { ...periodFilter, ...reportFilters });
        }).join("")}
          ${caseNumberCell(dailyTotal, { ...reportWindow, ...reportFilters })}${statusValues}`;
      };
      const byArea = new Map();
      for (const record of records) {
        if (!byArea.has(record.area)) byArea.set(record.area, []);
        byArea.get(record.area).push(record);
      }
      const grandTotal = emptyTotals();
      const body = [...byArea.entries()].map(([area, advisors]) => {
        const areaTotal = advisors.reduce((totals, record) => addTotals(totals, record), emptyTotals());
        addTotals(grandTotal, {
          dias: areaTotal.dias.map((total) => ({ total })),
          semanal: areaTotal.semanal
        });
        const advisorRows = advisors.map((record) => {
          const totals = {
            dias: record.dias.map((day) => day.total),
            semanal: record.semanal
          };
          const rowFilters = { area, advisor: record.asesor };
          return `<tr ${caseRowAttributes(detail, rowFilters)}><th class="advisor-name" scope="row">${escapeHtml(record.asesor)}</th>${renderValues(totals, rowFilters)}</tr>`;
        }).join("");
        const rowFilters = { area };
        return `<tr class="advisor-area-row" ${caseRowAttributes(detail, rowFilters)}><th scope="row">${escapeHtml(area)}</th>${renderValues(areaTotal, rowFilters)}</tr>${advisorRows}`;
      }).join("");

      table.innerHTML = `${columns}${header}<tbody>${body}</tbody>
        <tfoot><tr ${caseRowAttributes(detail)}><th scope="row">TOTAL GENERAL</th>${renderValues(grandTotal, {})}</tr></tfoot>`;
    }

    function renderAdvisorTransferTable(tableId, records, days, layout) {
      const table = document.getElementById(tableId);
      const isDerivedReceived = layout.direction === "received";
      const periods = layout.periods || [];
      const isMonthly = Boolean(layout.monthly);
      const detail = isDerivedReceived ? "recibidos_derivados" : "salientes";
      table.classList.add(layout.tableClass);
      const dayHeaders = days.map((day, index) =>
        `<th class="advisor-transfer-day-heading">${isMonthly
          ? periods[index].label
          : weekdayDateFormat.format(new Date(`${day}T00:00:00Z`)).replace(".", "")}</th>`
      ).join("");
      const transferColumnWidths = isDerivedReceived
        ? [5.5, 5.5, 7, 7, 10, 14]
        : [14, 7, 10, 5.5, 5.5, 7];
      const columnWidths = [13, ...days.map(() => 4.5), 6.5, ...transferColumnWidths];
      const columns = `<colgroup>${columnWidths.map((width) =>
        `<col style="width:${width}%">`
      ).join("")}</colgroup>`;
      const header = `${columns}<thead>
        <tr><th rowspan="2" scope="col">${layout.firstColumnHeading}</th>${dayHeaders}
          <th rowspan="2" scope="col">${isMonthly ? "TOTAL MES" : "TOTAL"}</th>
          <th colspan="${layout.transferColumnCount}">Seguimiento de Caso Derivado</th></tr>
        <tr>${days.map(() => '<th class="advisor-transfer-day-status">CASOS</th>').join("")}${layout.transferHeadings}</tr>
      </thead>`;
      const columnCount = 1 + days.length + 1 + layout.transferColumnCount;
      if (!records.length) {
        table.innerHTML = `${header}<tbody><tr><td class="empty" colspan="${columnCount}">Sin casos para ${isMonthly ? "el mes" : "esta semana"} con los filtros seleccionados.</td></tr></tbody>`;
        return;
      }

      const byArea = new Map();
      for (const record of records) {
        if (!byArea.has(record.area)) byArea.set(record.area, []);
        byArea.get(record.area).push(record);
      }
      const grandDays = days.map(() => 0);
      const reportWindow = isMonthly
        ? { reportStart: periods[0].start, reportEnd: periods[periods.length - 1].end }
        : { reportStart: days[0], reportEnd: days[days.length - 1] };
      const reportPeriodFilters = (index) => isMonthly
        ? { reportStart: periods[index].start, reportEnd: periods[index].end }
        : { ...reportWindow, reportDay: days[index] };
      const renderDailyValues = (dailyTotals, rowFilters, rowSpan = 1) =>
        dailyTotals.map((total, index) => caseNumberCell(
          total,
          { ...reportPeriodFilters(index), ...rowFilters },
          { rowSpan }
        )).join("");
      const body = [...byArea.entries()].map(([area, advisors]) => {
        const areaDays = days.map((_, index) =>
          advisors.reduce((total, record) => total + record.dias[index].total, 0)
        );
        areaDays.forEach((total, index) => { grandDays[index] += total; });
        const areaTotal = areaDays.reduce((total, value) => total + value, 0);
        const areaFilters = isDerivedReceived ? { area } : { areaSalida: area };
        const areaRow = `<tr class="advisor-area-row" ${caseRowAttributes(detail, areaFilters)}>
          <th scope="row">${escapeHtml(area)}</th>${areaDays.map((total, index) =>
            caseNumberCell(total, { ...reportPeriodFilters(index), ...areaFilters })
          ).join("")}
          ${caseNumberCell(areaTotal, { ...reportWindow, ...areaFilters })}<td colspan="${layout.transferColumnCount}"></td></tr>`;
        const advisorRows = advisors.map((record) => {
          const transfers = record.derivaciones || [];
          const rowSpan = Math.max(transfers.length, 1);
          const dailyTotals = record.dias.map((day) => day.total);
          const dailyTotal = dailyTotals.reduce((total, value) => total + value, 0);
          const advisorFilters = isDerivedReceived
            ? { area, asesorReporte: record.asesor }
            : { areaSalida: area, gestorSalida: record.asesor };
          const leftCells = `<th class="advisor-name" scope="row" rowspan="${rowSpan}">${escapeHtml(record.asesor)}</th>
            ${renderDailyValues(dailyTotals, advisorFilters, rowSpan)}
            ${caseNumberCell(dailyTotal, { ...reportWindow, ...advisorFilters }, { rowSpan })}`;
          if (!transfers.length) {
            return `<tr ${caseRowAttributes(detail, advisorFilters)}>${leftCells}<td colspan="6">—</td></tr>`;
          }

          const transferAreaCounts = new Map();
          for (const transfer of transfers) {
            transferAreaCounts.set(
              transfer[layout.transferAreaKey],
              (transferAreaCounts.get(transfer[layout.transferAreaKey]) || 0) + 1
            );
          }
          const transferAreaSeen = new Set();
          return transfers.map((transfer, index) => {
            const transferArea = transfer[layout.transferAreaKey] || layout.missingArea;
            const transferFilters = isDerivedReceived
              ? { ...advisorFilters, areaEmisora: transferArea, gestorEmisor: transfer[layout.transferAdvisorKey] }
              : { ...advisorFilters, areaDestino: transferArea, asesorDestino: transfer[layout.transferAdvisorKey] };
            const transferCell = (value, reportState = "") => caseNumberCell(value, {
              ...reportWindow,
              ...transferFilters,
              ...(reportState ? { reportState } : {})
            });
            const areaCell = transferAreaSeen.has(transferArea)
              ? ""
              : `<td class="advisor-receiver-area" rowspan="${transferAreaCounts.get(transferArea)}">${escapeHtml(transferArea)}</td>`;
            transferAreaSeen.add(transferArea);
            const transferAdvisor = `<td class="advisor-receiver-name">${escapeHtml(transfer[layout.transferAdvisorKey])}</td>`;
            const transferCells = isDerivedReceived
              ? `${transferCell(transfer.atendido, "atendido")}${transferCell(transfer.pendiente, "pendiente")}
                ${transferCell(transfer.sin_condicion, "sin_condicion")}${transferCell(transfer.total)}
                ${transferAdvisor}${areaCell}`
              : `${areaCell}${transferCell(transfer.total)}${transferAdvisor}
                ${transferCell(transfer.atendido, "atendido")}${transferCell(transfer.pendiente, "pendiente")}
                ${transferCell(transfer.sin_condicion, "sin_condicion")}`;
            return `<tr ${caseRowAttributes(detail, advisorFilters)}>${index === 0 ? leftCells : ""}${transferCells}</tr>`;
          }).join("");
        }).join("");
        return areaRow + advisorRows;
      }).join("");
      const grandTotal = grandDays.reduce((total, value) => total + value, 0);
      const grandTransferTotals = records.reduce((totals, record) => {
        for (const transfer of record.derivaciones || []) {
          totals.atendido += transfer.atendido || 0;
          totals.pendiente += transfer.pendiente || 0;
          totals.sin_condicion += transfer.sin_condicion || 0;
        }
        return totals;
      }, { atendido: 0, pendiente: 0, sin_condicion: 0 });
      const transferTotalsCells = isDerivedReceived
        ? `        ${caseNumberCell(grandTransferTotals.atendido, { ...reportWindow, reportState: "atendido" })}
        ${caseNumberCell(grandTransferTotals.pendiente, { ...reportWindow, reportState: "pendiente" })}
        ${caseNumberCell(grandTransferTotals.sin_condicion, { ...reportWindow, reportState: "sin_condicion" })}<td colspan="3"></td>`
        : `<td colspan="3"></td>${caseNumberCell(grandTransferTotals.atendido, { ...reportWindow, reportState: "atendido" })}
        ${caseNumberCell(grandTransferTotals.pendiente, { ...reportWindow, reportState: "pendiente" })}
        ${caseNumberCell(grandTransferTotals.sin_condicion, { ...reportWindow, reportState: "sin_condicion" })}`;
      table.innerHTML = `${header}<tbody>${body}</tbody>
        <tfoot><tr ${caseRowAttributes(detail)}><th scope="row">TOTAL GENERAL</th>${grandDays.map((total, index) =>
          caseNumberCell(total, reportPeriodFilters(index))
        ).join("")}
          ${caseNumberCell(grandTotal, reportWindow)}${transferTotalsCells}</tr></tfoot>`;
    }

    function renderDerivedReceivedTable(records, days, view = {}) {
      renderAdvisorTransferTable("advisor-derived-table", records, days, {
        direction: "received",
        monthly: view.monthly,
        periods: view.periods,
        tableClass: "advisor-flow-table-derived",
        firstColumnHeading: "ÁREA / ASESOR RECEPTOR",
        transferColumnCount: 6,
        transferHeadings: "<th>ATENDIDO</th><th>PENDIENTE</th><th>SIN CONDICIÓN FINAL</th><th>TOTAL DERIVADO</th><th>ASESOR EMISOR</th><th>ÁREA EMISORA</th>",
        transferAreaKey: "area_emisora",
        transferAdvisorKey: "asesor_emisor",
        missingArea: "SIN ÁREA EMISORA",
      });
    }

    function renderOutgoingAdvisorTable(records, days, view = {}) {
      renderAdvisorTransferTable("advisor-outgoing-table", records, days, {
        direction: "outgoing",
        monthly: view.monthly,
        periods: view.periods,
        tableClass: "advisor-flow-table-outgoing",
        firstColumnHeading: "ÁREA / ASESOR EMISOR",
        transferColumnCount: 6,
        transferHeadings: "<th>ÁREA RECEPTORA</th><th>TOTAL DERIVADO</th><th>ASESOR RECEPTOR</th><th>ATENDIDO</th><th>PENDIENTE</th><th>SIN CONDICIÓN FINAL</th>",
        transferAreaKey: "area_receptora",
        transferAdvisorKey: "receptor",
        missingArea: "SIN ÁREA RECEPTORA",
      });
    }

    function renderAdvisorFlowReport(data) {
      latestAdvisorFlowData = data;
      const receivedMonthly = advisorReceivedMode === "monthly";
      const derivedMonthly = advisorDerivedMode === "monthly";
      const outgoingMonthly = advisorOutgoingMode === "monthly";
      const receivedToggle = document.getElementById("advisor-received-mode-toggle");
      const derivedToggle = document.getElementById("advisor-derived-mode-toggle");
      const outgoingToggle = document.getElementById("advisor-outgoing-mode-toggle");
      receivedToggle.checked = receivedMonthly;
      receivedToggle.setAttribute("aria-checked", String(receivedMonthly));
      derivedToggle.checked = derivedMonthly;
      derivedToggle.setAttribute("aria-checked", String(derivedMonthly));
      outgoingToggle.checked = outgoingMonthly;
      outgoingToggle.setAttribute("aria-checked", String(outgoingMonthly));
      const monthPeriods = data.periodos_mensuales || [];
      const receivedPeriods = receivedMonthly ? monthPeriods : [];
      const derivedPeriods = derivedMonthly ? monthPeriods : [];
      const outgoingPeriods = outgoingMonthly ? monthPeriods : [];
      document.getElementById("advisor-flow-subtitle").textContent =
        `Semana ${formatDate(data.desde)} - ${formatDate(data.hasta)} · Vista según cada cuadro y filtros activos`;
      const visiblePanels = {
        TODAS: ["advisor-received-panel", "advisor-derived-panel", "advisor-outgoing-panel"],
        RECIBIDOS_NO_DERIVADOS: ["advisor-received-panel"],
        RECIBIDOS_DERIVADOS: ["advisor-derived-panel"],
        SALIENTES: ["advisor-outgoing-panel"]
      }[data.categoria] || [];
      for (const id of ["advisor-received-panel", "advisor-derived-panel", "advisor-outgoing-panel"]) {
        document.getElementById(id).hidden = !visiblePanels.includes(id);
      }
      renderAdvisorFlowTable(
        "advisor-received-table",
        receivedMonthly ? data.recibidos_no_derivados_mes : data.recibidos_no_derivados,
        receivedMonthly ? receivedPeriods.map((period) => period.start) : data.dias,
        [["cerrado", "CERRADO"], ["pendiente", "PENDIENTE DE CIERRE"], ["sin_condicion", "SIN CONDICIÓN USUARIO"]],
        "recibidos_no_derivados",
        { monthly: receivedMonthly, periods: receivedPeriods }
      );
      renderDerivedReceivedTable(
        derivedMonthly ? data.recibidos_derivados_mes : data.recibidos_derivados,
        derivedMonthly ? derivedPeriods.map((period) => period.start) : data.dias,
        { monthly: derivedMonthly, periods: derivedPeriods }
      );
      renderOutgoingAdvisorTable(
        outgoingMonthly ? data.salientes_mes : data.salientes,
        outgoingMonthly ? outgoingPeriods.map((period) => period.start) : data.dias,
        { monthly: outgoingMonthly, periods: outgoingPeriods }
      );
    }

    async function downloadPanelAsPng(panelId, filename) {
      const panel = document.getElementById(panelId);
      const table = panel.querySelector("table");
      const tableStyle = table ? getComputedStyle(table) : null;
      const tableMinWidth = Number.parseFloat(tableStyle?.minWidth) || 0;
      const tableRenderedWidth = table?.getBoundingClientRect().width || 0;
      const headingWidths = [...panel.querySelectorAll(".advisor-flow-title, .section-heading h2")]
        .map((heading) => {
          const textRange = document.createRange();
          textRange.selectNodeContents(heading);
          return textRange.getBoundingClientRect().width;
        });
      const isFollowupExport = panelId === "followup-section";
      const isAdvisorWeekExport = panelId === "advisor-week-section";
      const isAreaEfficiencyExport = panelId === "area-efficiency-section";
      const measuredWidth = Math.max(
        tableMinWidth,
        isAdvisorWeekExport || isAreaEfficiencyExport ? tableRenderedWidth : 0,
        ...headingWidths
      );
      const contentWidth = Math.ceil(
        isFollowupExport || isAdvisorWeekExport || isAreaEfficiencyExport
          ? measuredWidth
          : measuredWidth * 1.65
      );
      const isOutgoingExport = panelId === "advisor-outgoing-panel";
      const cardPadding = 18;
      const cardBorder = 2;
      const width = Math.ceil(contentWidth + (cardPadding + cardBorder) * 2);
      const styleExportClone = (clone, bottomPadding = cardPadding) => {
        clone.querySelectorAll(".table-download-button").forEach((button) => button.remove());
        clone.querySelectorAll(".advisor-week-toolbar").forEach((toolbar) => toolbar.remove());
        const areaBackButton = clone.querySelector("#area-efficiency-back");
        if (areaBackButton) areaBackButton.remove();
        clone.style.width = `${width}px`;
        clone.style.maxWidth = "none";
        clone.style.margin = "0";
        clone.style.background = "#fff";
        clone.style.backgroundColor = "#fff";
        clone.style.padding = `${cardPadding}px ${cardPadding}px ${bottomPadding}px`;
        clone.style.border = `${cardBorder}px solid ${isAreaEfficiencyExport ? "#fff" : "#cbd5e1"}`;
        clone.style.borderRadius = "12px";
        clone.style.overflow = "visible";
        clone.style.boxShadow = "none";
        clone.querySelectorAll(".table-panel, .panel, .section-heading, .table-head, .advisor-flow-panel, .area-efficiency-chart-card, .area-category-comparison-card, .area-motive-breakdown-card").forEach((section) => {
          section.style.background = "#fff";
          section.style.boxShadow = "none";
          section.style.borderColor = "#dfeaf3";
        });
        clone.querySelectorAll(".advisor-flow-table-wrap, .advisor-week-table-wrap, .table-scroll").forEach((wrapper) => {
          wrapper.style.width = `${contentWidth}px`;
          wrapper.style.height = "auto";
          wrapper.style.overflow = "visible";
        });
        clone.querySelectorAll(".advisor-week-table-wrap").forEach((wrapper) => {
          const tablePanel = wrapper.closest(".panel");
          if (!tablePanel) return;
          tablePanel.style.padding = "0";
          tablePanel.style.border = "0";
          tablePanel.style.boxShadow = "none";
        });
        clone.querySelectorAll(".advisor-flow-title, .section-heading h2, .panel-title").forEach((heading) => {
          heading.style.fontSize = "21px";
          heading.style.lineHeight = "1.3";
          heading.style.marginBottom = "16px";
        });
        clone.querySelectorAll(".section-heading").forEach((heading) => {
          heading.style.margin = "0 0 16px";
        });
        clone.querySelectorAll("table").forEach((exportTable) => {
          exportTable.style.width = `${contentWidth}px`;
          exportTable.style.minWidth = `${contentWidth}px`;
          exportTable.style.tableLayout = "fixed";
          exportTable.style.whiteSpace = "normal";
          exportTable.style.border = isAreaEfficiencyExport ? "1px solid #dfeaf3" : "1px solid #dfe8f0";
          exportTable.style.borderCollapse = "collapse";
          exportTable.querySelectorAll("th, td").forEach((cell) => {
            cell.style.position = "static";
            cell.style.border = isAreaEfficiencyExport ? "1px solid #dfeaf3" : "1px solid #dfe8f0";
            cell.style.padding = isAdvisorWeekExport
              ? "7px 5px"
              : isOutgoingExport
                ? "12px 6px"
                : "10px 6px";
            cell.style.fontSize = isAdvisorWeekExport ? "9px" : "12px";
            cell.style.lineHeight = "1.25";
            cell.style.verticalAlign = "middle";
            cell.style.whiteSpace = "normal";
            cell.style.overflowWrap = "anywhere";
            cell.style.wordBreak = "normal";
            cell.style.textAlign = "center";
          });
        });
        clone.querySelectorAll(".advisor-flow-table-outgoing .advisor-receiver-area, .advisor-flow-table-outgoing .advisor-name, .advisor-flow-table-outgoing .advisor-receiver-name").forEach((cell) => {
          cell.style.minWidth = "0";
          cell.style.whiteSpace = "normal";
        });
      };

      const measureClone = panel.cloneNode(true);
      measureClone.removeAttribute("id");
      measureClone.style.position = "fixed";
      measureClone.style.left = "-10000px";
      measureClone.style.top = "0";
      measureClone.style.margin = "0";
      document.body.append(measureClone);
      let cardBottomPadding = cardPadding;
      let height;
      try {
        styleExportClone(measureClone);
        const measuredTable = measureClone.querySelector("table");
        const tableHeight = measuredTable?.getBoundingClientRect().height || 0;
        if (isOutgoingExport) {
          cardBottomPadding = Math.max(80, Math.ceil(tableHeight * 0.1));
        }
        measureClone.style.paddingBottom = `${cardBottomPadding}px`;
        height = Math.ceil(measureClone.getBoundingClientRect().height);
      } finally {
        measureClone.remove();
      }

      const scale = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(40000000 / (width * height)));
      const renderCanvas = await loadHtml2Canvas();
      const canvas = await renderCanvas(panel, {
        backgroundColor: "#fff",
        scale,
        width,
        height,
        windowWidth: width,
        onclone: (clonedDocument) => {
          const clone = clonedDocument.getElementById(panelId);
          if (clone) {
            clone.style.background = "#fff";
            clone.style.backgroundColor = "#fff";
            clone.style.boxShadow = "none";
            clone.style.border = "0";
          }
          styleExportClone(clonedDocument.getElementById(panelId), cardBottomPadding);
        },
      });
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("No se pudo generar el archivo PNG.");
      const pngUrl = URL.createObjectURL(png);
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
    }

    document.querySelectorAll(".table-download-button").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await downloadPanelAsPng(button.dataset.exportTarget, button.dataset.exportName);
        } catch (error) {
          const notice = document.getElementById("data-notice");
          notice.classList.add("error");
          notice.textContent = error.message || "No se pudo descargar el cuadro como PNG.";
        } finally {
          button.disabled = false;
        }
      });
    });

    const statusStyles = new Map([
      ["ATENDIDO", "ok"],
      ["CERRADO", "ok"],
      ["SOLUCIONADO", "ok"],
      ["EN PLAZO", "ok"],
      ["PENDIENTE", "warning"],
      ["ALERTA 3-7 DÍAS", "warning"],
      ["DERIVADO", "info"],
      ["NO SOLUCIONADO", "alert"],
      ["VENCIDO > 7 DÍAS", "alert"],
      ["NO ES DERIVADO", "neutral"],
    ]);

    function statusButton(value) {
      const status = String(value || "").trim();
      const style = statusStyles.get(status.toUpperCase()) || "neutral";
      return `<span class="status-button ${style}">${escapeHtml(status)}</span>`;
    }

    function renderTable(result) {
      const rows = result.casos;
      displayedCases = rows;
      const body = document.getElementById("cases-table");
      const columns = result.columnas_casos.filter(
        (column) => column !== "MOTIVO FINAL" && column !== "SUBMOTIVO FINAL"
      );
      document.querySelector("#cases-head tr").innerHTML =
        columns.map((column) => `<th>${escapeHtml(
          column === "DETALLE DEL MOTIVO (VERSION DEL USUARIO)" ? "DETALLE DEL MOTIVO" : column
        )}</th>`).join("");
      const tableTitle = document.getElementById("cases-title");
      tableTitle.textContent = result.detalle_titulo;
      document.getElementById("case-detail-back").hidden = !result.detalle;
      const firstItem = rows.length ? (result.pagina - 1) * (result.detalle ? 10 : 12) + 1 : 0;
      const lastItem = firstItem + rows.length - 1;
      document.getElementById("table-count").textContent = result.detalle
        ? `${numberFormat.format(firstItem)}–${numberFormat.format(lastItem)} de ${numberFormat.format(result.casos_total)} casos`
        : `${numberFormat.format(rows.length)} casos recientes`;
      const pagination = document.getElementById("table-pagination");
      pagination.hidden = !result.detalle;
      if (result.detalle) {
        document.getElementById("detail-page").textContent =
          `Página ${numberFormat.format(result.pagina)} de ${numberFormat.format(result.paginas)}`;
        document.getElementById("detail-prev").disabled = result.pagina <= 1;
        document.getElementById("detail-next").disabled = result.pagina >= result.paginas;
      }
      if (!rows.length) {
        body.innerHTML = `<tr><td class="empty" colspan="${columns.length}">No hay casos que coincidan con los filtros.</td></tr>`;
        return;
      }
      const dateColumns = new Set(["FECHA INGRESO", "FECHA CIERRE", "FECHA RECEPCIÓN", "FECHA FINAL"]);
      const fullTextColumns = new Set([
        "DETALLE DEL MOTIVO (VERSION DEL USUARIO)",
        "ATENCIÓN BRINDADA"
      ]);
      const statusColumns = new Set([
        "CONDICIÓN USUARIO",
        "CONDICIÓN FINAL USUARIO",
        "ALERTA TIEMPO",
        "ALERTA SOLUCIÓN"
      ]);
      const eyeIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="12" cy="12" r="2.7" stroke="currentColor" stroke-width="1.8"/>
      </svg>`;
      const warningIcon = `<svg class="alert-record-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3.5 22 21H2L12 3.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M12 9v5.5M12 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
      const checkIcon = `<svg class="complete-record-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
      body.innerHTML = rows.map((row, rowIndex) => `<tr>${columns.map((column) => {
        const value = row[column];
        if (column === "ALERTA CAMPOS VACÍOS") {
          if (String(value || "").trim().toUpperCase() === "COMPLETO") {
            return `<td><span class="complete-record-cell">${checkIcon}<span>COMPLETO</span></span></td>`;
          }
          return `<td><span class="alert-record-cell">${warningIcon}<button type="button" class="record-view-button" data-case-index="${rowIndex}" aria-label="Ver alertas completas del caso ${escapeHtml(row["ID CASO"] || "")}" title="Ver alertas completas">${eyeIcon}</button></span></td>`;
        }
        if (fullTextColumns.has(column)) {
          return value
            ? `<td><button type="button" class="text-view-button" data-text-column="${escapeHtml(column)}" data-full-text="${escapeHtml(value)}" aria-label="Leer texto completo de ${escapeHtml(column)}" title="Leer texto completo">${eyeIcon}</button></td>`
            : "<td>—</td>";
        }
        if (column === "DNI") {
          const dni = String(value ?? "").trim();
          return dni && dni !== "—"
            ? `<td><button type="button" class="dni-filter-button" data-case-dni="${escapeHtml(dni)}" aria-label="Ver todos los casos asociados al DNI ${escapeHtml(dni)}" title="Ver todos los casos de este DNI">${escapeHtml(dni)}</button></td>`
            : "<td>—</td>";
        }
        const statusValue = String(value ?? "").trim();
        if (statusColumns.has(column) && statusValue && statusValue !== "—") {
          return `<td>${statusButton(statusValue)}</td>`;
        }
        const displayValue = dateColumns.has(column) && value
          ? dateFormat.format(new Date(`${value}T00:00:00Z`))
          : (value || "—");
        return `<td>${escapeHtml(displayValue)}</td>`;
      }).join("")}</tr>`).join("");
    }

    function renderFollowup(result) {
      displayedFollowupCases = result.casos;
      const columns = [
        ["ID CASO", "ID CASO"],
        ["FECHA INGRESO", "INGRESO"],
        ["ASESOR FINAL", "RESPONSABLE"],
        ["ÁREA FINAL", "ÁREA"],
        ["MOTIVO FINAL", "MOTIVO"],
        ["SUBMOTIVO FINAL", "SUBMOTIVO"],
        ["DÍAS TRANSCURRIDOS", "DÍAS TRANSCURRIDOS"],
        ["ALERTA TIEMPO", "ALERTA TIEMPO"],
        ["ALERTA CAMPOS VACÍOS", "ALERTA CAMPOS VACÍOS"],
        ["OBSERVACIÓN", "DETALLE GESTIÓN PENDIENTE Y TIEMPO DE ACCIÓN"],
        ["VER MÁS", "VER MÁS"]
      ];
      document.querySelector("#followup-head tr").innerHTML = columns
        .map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("");

      const body = document.getElementById("followup-body");
      if (!result.casos.length) {
        body.innerHTML = `<tr><td class="empty" colspan="${columns.length}">SIN CASOS NO SOLUCIONADOS</td></tr>`;
      } else {
        const eyeIcon = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="12" cy="12" r="2.7" stroke="currentColor" stroke-width="1.8"/>
        </svg>`;
        const warningIcon = `<svg class="alert-record-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3.5 22 21H2L12 3.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M12 9v5.5M12 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
        const checkIcon = `<svg class="complete-record-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        body.innerHTML = result.casos.map((row, rowIndex) => `<tr>${columns.map(([key]) => {
          if (key === "VER MÁS") {
            return `<td><button type="button" class="followup-detail-button" data-followup-case-id="${escapeHtml(row["ID CASO"])}" aria-label="Ver detalle del caso ${escapeHtml(row["ID CASO"])}">Ver más</button></td>`;
          }
          if (key === "ALERTA CAMPOS VACÍOS") {
            if (String(row[key] || "").trim().toUpperCase() === "COMPLETO") {
              return `<td><span class="complete-record-cell">${checkIcon}<span>COMPLETO</span></span></td>`;
            }
            return `<td><span class="alert-record-cell">${warningIcon}<button type="button" class="record-view-button followup-record-view-button" data-case-index="${rowIndex}" aria-label="Ver alertas completas del caso ${escapeHtml(row["ID CASO"] || "")}" title="Ver alertas completas">${eyeIcon}</button></span></td>`;
          }
          if (key === "ALERTA TIEMPO") {
            const status = String(row[key] || "").trim();
            return `<td>${status ? statusButton(status) : "—"}</td>`;
          }
          const value = key === "FECHA INGRESO" ? formatDate(row[key]) : row[key];
          return `<td>${escapeHtml(value || "—")}</td>`;
        }).join("")}</tr>`).join("");
      }

      const firstItem = result.total ? (result.pagina - 1) * 20 + 1 : 0;
      const lastItem = Math.min(result.pagina * 20, result.total);
      document.getElementById("followup-subtitle").textContent =
        `Casos no solucionados con fecha de ingreso del ${formatDate(result.periodo_desde)} al ${formatDate(result.periodo_hasta)}`;
      document.getElementById("followup-count").textContent =
        `${numberFormat.format(firstItem)}–${numberFormat.format(lastItem)} de ${numberFormat.format(result.total)} casos`;
      const pagination = document.getElementById("followup-pagination");
      pagination.hidden = result.paginas <= 1;
      document.getElementById("followup-page").textContent =
        `Página ${numberFormat.format(result.pagina)} de ${numberFormat.format(result.paginas)}`;
      document.getElementById("followup-prev").disabled = result.pagina <= 1;
      document.getElementById("followup-next").disabled = result.pagina >= result.paginas;
    }

    function setOptions(selectId, values, placeholder) {
      const select = document.getElementById(selectId);
      const selected = select.value;
      select.innerHTML = `<option value="">${placeholder}</option>` + values.map((value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
      ).join("");
      if (values.includes(selected)) select.value = selected;
    }

    function updateAdvisorOptions() {
      const selectedArea = document.getElementById("area").value;
      const advisors = selectedArea
        ? [...new Set(advisorDirectory
          .filter((record) => record.area === selectedArea)
          .map((record) => record.asesor))]
        : allAdvisorOptions;
      setOptions("gestor", advisors, "Todos los asesores");
    }

    function updateClassificationOptions() {
      const selectedType = document.getElementById("tipo").value;
      const matchingRows = motiveHierarchy.filter((record) =>
        !selectedType || record.tipo === selectedType
      );
      const motiveOptions = selectedType
        ? [...new Set(matchingRows.map((record) => record.motivo))].sort((left, right) =>
          left.localeCompare(right, "es")
        )
        : allMotiveOptions;
      setOptions("motivo", motiveOptions, "Todos los motivos");

      const selectedMotive = document.getElementById("motivo").value;
      const submotiveOptions = selectedType || selectedMotive
        ? [...new Set(matchingRows
          .filter((record) => !selectedMotive || record.motivo === selectedMotive)
          .map((record) => record.submotivo)
          .filter(Boolean))].sort((left, right) => left.localeCompare(right, "es"))
        : allSubmotiveOptions;
      setOptions("submotivo", submotiveOptions, "Todos los submotivos");
    }

    function formatDate(value) {
      return value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : "—";
    }

    function formatDateFilter(value) {
      if (!value) return "";
      const [year, month, day] = value.split("-");
      return `${day}/${month}/${year}`;
    }

    function parseDateFilter(value) {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
      if (!match) return null;
      const [, day, month, year] = match;
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (
        Number(year) < 1000 ||
        date.getUTCFullYear() !== Number(year) ||
        date.getUTCMonth() !== Number(month) - 1 ||
        date.getUTCDate() !== Number(day)
      ) return null;
      return `${year}-${month}-${day}`;
    }

    function selectedAreaChartPeriod() {
      if (selectedChartDay !== null) {
        return { desde: selectedChartDay, hasta: selectedChartDay };
      }
      if (selectedChartWeek !== null) {
        return { desde: selectedChartWeek.start, hasta: selectedChartWeek.end };
      }
      if (selectedChartYear !== null && selectedChartMonth !== null) {
        const monthStart = `${selectedChartYear}-${String(selectedChartMonth).padStart(2, "0")}-01`;
        const lastDay = new Date(Date.UTC(selectedChartYear, selectedChartMonth, 0)).getUTCDate();
        return {
          desde: monthStart,
          hasta: `${selectedChartYear}-${String(selectedChartMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
        };
      }
      if (selectedChartYear !== null) {
        return { desde: `${selectedChartYear}-01-01`, hasta: `${selectedChartYear}-12-31` };
      }
      return null;
    }

    function setChartDateRange(start, end) {
      document.getElementById("desde").value = formatDateFilter(start);
      document.getElementById("hasta").value = formatDateFilter(end);
    }

    function chartYearDateRange(year) {
      return { start: `${year}-01-01`, end: `${year}-12-31` };
    }

    function chartMonthDateRange(year, month) {
      const monthValue = String(month).padStart(2, "0");
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return {
        start: `${year}-${monthValue}-01`,
        end: `${year}-${monthValue}-${String(lastDay).padStart(2, "0")}`
      };
    }

    function validateDateFilter(input) {
      const valid = !input.value || parseDateFilter(input.value) !== null;
      input.setCustomValidity(valid ? "" : "Ingresa una fecha válida en formato DD/MM/AAAA.");
      if (!valid) input.reportValidity();
      return valid;
    }

    function currentFilterParams() {
      const params = new URLSearchParams();
      for (const id of filterIds) {
        const value = document.getElementById(id).value;
        const queryValue = id === "desde" || id === "hasta" ? parseDateFilter(value) : value;
        if (queryValue) params.set(id, queryValue);
      }
      return params;
    }

    function rememberCaseDetailReturnState() {
      if (caseDetailReturnScrollY !== null) return;
      caseDetailReturnScrollY = window.scrollY;
      caseDetailReturnView = document.getElementById("main-content")
        .classList.contains("advisor-view-active")
        ? "advisors"
        : "dashboard";
      caseDetailReturnFilters = Object.fromEntries(filterIds.map((id) =>
        [id, document.getElementById(id).value]
      ));
    }

    function restoreCaseDetailReturnFilters(filters) {
      if (!filters) return;
      for (const id of filterIds) {
        if (!["gestor", "tipo", "motivo", "submotivo"].includes(id)) {
          document.getElementById(id).value = filters[id];
        }
      }
      updateAdvisorOptions();
      document.getElementById("gestor").value = filters.gestor;
      document.getElementById("tipo").value = filters.tipo;
      updateClassificationOptions();
      document.getElementById("motivo").value = filters.motivo;
      updateClassificationOptions();
      document.getElementById("submotivo").value = filters.submotivo;
    }

    function dashboardParams() {
      const params = currentFilterParams();
      for (const [parameter, value] of Object.entries(activeReportFilter)) {
        if (value) params.set(parameter, value);
      }
      params.set("seguimiento_pagina", String(followupPage));
      const areaPeriod = selectedAreaChartPeriod();
      if (areaPeriod) {
        params.set("area_desde", areaPeriod.desde);
        params.set("area_hasta", areaPeriod.hasta);
      }
      if (activeDetail) {
        params.set("detalle", activeDetail);
        params.set("pagina", String(activePage));
      }
      return params;
    }

    async function loadCaseDetail() {
      rememberCaseDetailReturnState();
      if (activeCaseRequest) activeCaseRequest.abort();
      const request = new AbortController();
      activeCaseRequest = request;
      try {
        const response = await fetch(`/api/dashboard?${dashboardParams().toString()}`, { signal: request.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "No se pudo cargar el detalle de casos.");
        renderTable(result);
      } catch (error) {
        if (error.name === "AbortError") return;
        const notice = document.getElementById("data-notice");
        notice.classList.add("error");
        notice.textContent = error.message || "No se pudo cargar el detalle de casos.";
      } finally {
        if (activeCaseRequest === request) activeCaseRequest = undefined;
      }
    }

    function openDniCases(dni) {
      activeDetail = "dni";
      activeReportFilter = { dni };
      activePage = 1;
      loadCaseDetail().then(() => {
        document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    async function loadDashboard(resetFollowupPage = true) {
      if (resetFollowupPage) followupPage = 1;
      let reloadForUpdatedPeriod = false;
      if (activeRequest) activeRequest.abort();
      if (activeCaseRequest) activeCaseRequest.abort();
      if (activeAdvisorFlowRequest) {
        activeAdvisorFlowRequest.abort();
        activeAdvisorFlowRequest = undefined;
      }
      const request = new AbortController();
      activeRequest = request;
      const shell = document.querySelector(".shell");
      shell.classList.add("loading");
      const areaPeriod = selectedAreaChartPeriod();

      try {
        const response = await fetch(`/api/dashboard?${dashboardParams().toString()}`, { signal: request.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "No se pudo cargar el panel.");
        const sourceVersionChanged =
          lastSourceVersion !== undefined && result.version_fuente !== lastSourceVersion;
        if (basePeriod && sourceVersionChanged) {
          const dateStart = document.getElementById("desde");
          const dateEnd = document.getElementById("hasta");
          const usingFullPeriod =
            dateStart.value === formatDateFilter(basePeriod.desde)
            && dateEnd.value === formatDateFilter(basePeriod.hasta);
          const periodChanged =
            result.periodo.desde !== basePeriod.desde
            || result.periodo.hasta !== basePeriod.hasta;
          basePeriod = result.periodo;
          if (usingFullPeriod && periodChanged) {
            dateStart.value = formatDateFilter(basePeriod.desde);
            dateEnd.value = formatDateFilter(basePeriod.hasta);
            reloadForUpdatedPeriod = true;
          }
        }
        lastSourceVersion = result.version_fuente;
        activeUploadedFilename = result.archivo_cargado || "";
        advisorDirectory = result.directorio_asesores || [];
        allAdvisorOptions = result.opciones.gestores || [];
        motiveHierarchy = result.jerarquia_motivos || [];
        allMotiveOptions = result.opciones.motivos || [];
        allSubmotiveOptions = result.opciones.submotivos || [];
        updateAdvisorOptions();
        updateClassificationOptions();
        const dataNotice = document.getElementById("data-notice");
        dataNotice.classList.remove("error");
        dataNotice.classList.toggle("warning", Boolean(result.aviso_datos));

        if (!basePeriod) {
          basePeriod = result.periodo;
          document.getElementById("desde").value = formatDateFilter(basePeriod.desde);
          document.getElementById("hasta").value = formatDateFilter(basePeriod.hasta);
          setOptions("area", result.opciones.areas, "Todas las áreas");
          updateAdvisorOptions();
          setOptions("tipo", result.opciones.tipos, "Todos los tipos");
          updateClassificationOptions();
          setOptions("empresa", result.opciones.empresas, "Todas las empresas");
          setOptions("canal", result.opciones.canales, "Todos los canales");
        }

        document.getElementById("period-pill").textContent =
          `Periodo disponible: ${formatDate(result.periodo.desde)} – ${formatDate(result.periodo.hasta)}`;
        const sourceDescription = result.aviso_datos
          || `Fuente de datos: ${result.origen_datos}.`;
        const updatedDescription = result.actualizado_en
          ? ` Última actualización: ${new Date(result.actualizado_en).toLocaleString("es-PE")}.`
          : "";
        dataNotice.textContent =
          `${sourceDescription}${updatedDescription} ${activeUploadedFilename ? `Archivo activo: ${activeUploadedFilename} · ` : ""}${numberFormat.format(result.total_base)} registros en BD FINAL · ${result.modo_saliente ? "Salidas atribuidas al área de origen" : "Ingresos atribuidos según la categoría"}: ${numberFormat.format(result.kpis.total)}.`;
        document.getElementById("general-subtitle").textContent = result.modo_saliente
          ? "Casos salientes; solucionados = cerrados + derivados atendidos"
          : "Casos ingresados; solucionados = cerrados + derivados atendidos";
        const qualityNotice = document.getElementById("quality-notice");
        qualityNotice.hidden = result.revision_calidad === 0;
        qualityNotice.textContent = result.revision_calidad
          ? `Revisión de conteo: ${numberFormat.format(result.revision_calidad)} registros tienen origen y destino iguales; BD FINAL los marca para revisar y no los suma como salida.`
          : "";

        chartYears = result.por_anio;
        chartMonths = result.por_mes;
        chartWeeks = result.por_semana;
        chartDays = result.por_dia || [];
        chartKpis = result.kpis;
        renderMetrics(result.kpis, result.modo_saliente, result.categoria);
        renderIncomeChart(
          chartYears, chartMonths, chartWeeks, chartDays, chartKpis,
          selectedChartYear, selectedChartMonth, selectedChartWeek, result.modo_saliente
        );
        renderAreaChart(
          result.modo_saliente ? result.por_area_remitente : result.por_area_receptora,
          result.modo_saliente
        );
        const areaSubtitle = document.getElementById("area-chart-subtitle");
        const areaAttribution = result.modo_saliente
          ? "ÁREA INICIAL (origen)"
          : "ÁREA INICIAL para no derivados y ÁREA DERIVADA para recibidos derivados";
        areaSubtitle.textContent = areaPeriod
          ? `Casos atribuidos a ${areaAttribution}, separados por solución · ${formatDate(areaPeriod.desde)}${areaPeriod.desde === areaPeriod.hasta ? "" : ` - ${formatDate(areaPeriod.hasta)}`}`
          : `Casos atribuidos a ${areaAttribution}, separados por solución`;
        renderAreaEfficiency(result);
        renderAreaEfficiencyCharts(
          result.resumen_eficiencia_areas,
          result.resumen_asesores
        );
        renderMotiveBreakdown(
          result.desglose_motivos_tipo,
          result.totales_desglose_motivos_tipo
        );
        renderTypeCategoryTable(
          result.cuadro_empresas,
          "company-comparison-body",
          "company-comparison-foot",
          "empresas",
          "empresa"
        );
        renderTypeCategoryTable(
          result.cuadro_canales,
          "channel-comparison-body",
          "channel-comparison-foot",
          "canales",
          "canal"
        );
        if (
          advisorWeekMode === "monthly"
          && result.seguimiento_mensual_asesores?.registros?.length
          && !hasAdvisorMonthWeeks(result.seguimiento_mensual_asesores)
        ) {
          result.seguimiento_mensual_asesores = await loadAdvisorMonthWeeks(
            result.seguimiento_mensual_asesores,
            request.signal
          );
        }
        renderAdvisorWeek(
          result.seguimiento_semanal_asesores,
          result.seguimiento_mensual_asesores
        );
        if (
          (advisorReceivedMode === "monthly"
            || advisorDerivedMode === "monthly"
            || advisorOutgoingMode === "monthly")
          && !hasAdvisorFlowMonthData(result.flujo_semanal_asesores, result.seguimiento_mensual_asesores)
        ) {
          result.flujo_semanal_asesores = await loadAdvisorFlowMonthData(
            result.flujo_semanal_asesores,
            result.seguimiento_mensual_asesores,
            request.signal
          );
        }
        renderAdvisorFlowReport(result.flujo_semanal_asesores);
        renderBars("channel-chart", result.por_canal, "canal");
        renderBars("company-chart", result.por_empresa, "empresa");
        renderReasonChart(
          result.por_motivo,
          result.por_submotivo,
          document.getElementById("motivo").value
        );
        renderQuality(result.calidad);
        renderFollowup(result.seguimiento_casos);
        renderTable(result);
      } catch (error) {
        if (error.name === "AbortError") return;
        const notice = document.getElementById("data-notice");
        notice.classList.remove("warning");
        notice.classList.add("error");
        notice.textContent = error.message || "No se pudo conectar con el servidor.";
      } finally {
        if (activeRequest === request) {
          activeRequest = undefined;
          shell.classList.remove("loading");
          if (reloadForUpdatedPeriod) {
            window.setTimeout(() => loadDashboard(false), 0);
          }
        }
      }
    }

    const uploadButton = document.getElementById("upload-excel-button");
    const uploadInput = document.getElementById("excel-file-input");
    uploadButton.addEventListener("click", () => uploadInput.click());
    uploadInput.addEventListener("change", async () => {
      const file = uploadInput.files[0];
      if (!file) return;

      uploadButton.disabled = true;
      uploadButton.textContent = "Procesando...";
      const notice = document.getElementById("data-notice");
      notice.classList.remove("error");
      notice.textContent = `Procesando ${file.name}...`;
      const formData = new FormData();
      formData.append("archivo", file);

      try {
        const response = await fetch("/api/cargar-excel", { method: "POST", body: formData });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "No se pudo procesar el archivo.");

        activeUploadedFilename = result.archivo;
        basePeriod = undefined;
        for (const id of filterIds) {
          document.getElementById(id).value = "";
        }
        activeDetail = "";
        activeReportFilter = {};
        activePage = 1;
        selectedChartYear = null;
        selectedChartMonth = null;
        selectedChartWeek = null;
        selectedChartDay = null;
        chartBaseDateRange = null;
        await loadDashboard();
      } catch (error) {
        notice.classList.add("error");
        notice.textContent = error.message || "No se pudo procesar el archivo.";
      } finally {
        uploadButton.disabled = false;
        uploadButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Cargar Excel`;
        uploadInput.value = "";
      }
    });
    document.getElementById("export-excel-button").addEventListener("click", async (event) => {
      const exportButton = event.currentTarget;
      const startDate = document.getElementById("desde");
      const endDate = document.getElementById("hasta");
      if (!validateDateFilter(startDate) || !validateDateFilter(endDate)) return;

      exportButton.disabled = true;
      try {
        const params = currentFilterParams();
        params.set("exportar_excel", "true");
        const response = await fetch(`/api/dashboard?${params.toString()}`);
        if (!response.ok) {
          let message = `No se pudo exportar (HTTP ${response.status}).`;
          if ((response.headers.get("content-type") || "").includes("application/json")) {
            const result = await response.json();
            message = result.detail || message;
          }
          throw new Error(message);
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
          throw new Error("El servidor no devolvió un archivo Excel válido.");
        }
        const downloadUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = "casos-filtrados.xlsx";
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      } catch (error) {
        const notice = document.getElementById("data-notice");
        notice.classList.add("error");
        notice.textContent = error.message || "No se pudo exportar los casos.";
      } finally {
        exportButton.disabled = false;
      }
    });

    for (const id of filterIds.filter((item) => item !== "buscar")) {
      document.getElementById(id).addEventListener("change", () => {
        if ((id === "desde" || id === "hasta") && !validateDateFilter(document.getElementById(id))) return;
        if (id === "area" || id === "gestor") selectedAreaEfficiencyAdvisor = "";
        if (id === "motivo") document.getElementById("submotivo").value = "";
        if (id === "area") updateAdvisorOptions();
        if (id === "tipo" || id === "motivo") updateClassificationOptions();
        activeReportFilter = {};
        if (id === "desde" || id === "hasta") {
          selectedChartYear = null;
          selectedChartMonth = null;
          selectedChartWeek = null;
          selectedChartDay = null;
          chartBaseDateRange = null;
        }
        activePage = 1;
        loadDashboard();
      });
    }
    document.getElementById("buscar").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        activeReportFilter = {};
        activePage = 1;
        loadDashboard();
      }, 300);
    });
    document.getElementById("reason-chart").addEventListener("click", (event) => {
      const submotif = event.target.closest("[data-submotivo]");
      if (submotif) {
        rememberCaseDetailReturnState();
        document.getElementById("submotivo").value = submotif.dataset.submotivo;
        activeDetail = "total";
        activeReportFilter = {};
        activePage = 1;
        loadCaseDetail().then(() => {
          document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
        });
        return;
      }
      const reason = event.target.closest("[data-reason]");
      if (!reason) return;
      document.getElementById("motivo").value = reason.dataset.reason;
      document.getElementById("submotivo").value = "";
      activeReportFilter = {};
      activePage = 1;
      loadDashboard();
    });
    document.getElementById("reason-chart").addEventListener("keydown", (event) => {
      const item = event.target.closest("[data-reason], [data-submotivo]");
      if ((event.key === "Enter" || event.key === " ") && item) {
        event.preventDefault();
        item.click();
      }
    });
    document.getElementById("reason-chart-back").addEventListener("click", () => {
      document.getElementById("motivo").value = "";
      document.getElementById("submotivo").value = "";
      activeReportFilter = {};
      activePage = 1;
      loadDashboard();
    });
    for (const chartId of ["channel-chart", "company-chart"]) {
      const chart = document.getElementById(chartId);
      chart.addEventListener("click", (event) => {
        const category = event.target.closest("[data-category-filter]");
        if (!category) return;
        rememberCaseDetailReturnState();
        document.getElementById(category.dataset.categoryFilter).value = category.dataset.categoryValue;
        activeDetail = "total";
        activeReportFilter = {};
        activePage = 1;
        loadCaseDetail().then(() => {
          document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
      chart.addEventListener("keydown", (event) => {
        const category = event.target.closest("[data-category-filter]");
        if ((event.key === "Enter" || event.key === " ") && category) {
          event.preventDefault();
          category.click();
        }
      });
    }
    document.getElementById("clear").addEventListener("click", () => {
      for (const id of filterIds) {
        document.getElementById(id).value = "";
      }
      updateAdvisorOptions();
      updateClassificationOptions();
      if (basePeriod) {
        document.getElementById("desde").value = formatDateFilter(basePeriod.desde);
        document.getElementById("hasta").value = formatDateFilter(basePeriod.hasta);
      }
      activeDetail = "";
      activeReportFilter = {};
      activePage = 1;
      selectedChartYear = null;
      selectedChartMonth = null;
      selectedChartWeek = null;
      selectedChartDay = null;
      chartBaseDateRange = null;
      loadDashboard();
    });

    document.getElementById("followup-prev").addEventListener("click", () => {
      if (followupPage <= 1) return;
      followupPage -= 1;
      loadDashboard(false);
    });
    document.getElementById("followup-next").addEventListener("click", () => {
      followupPage += 1;
      loadDashboard(false);
    });

    document.getElementById("monthly-chart").addEventListener("click", (event) => {
      const yearBar = event.target.closest("[data-chart-year]");
      if (yearBar) {
        chartBaseDateRange = {
          desde: document.getElementById("desde").value,
          hasta: document.getElementById("hasta").value
        };
        selectedChartYear = Number(yearBar.dataset.chartYear);
        selectedChartMonth = null;
        selectedChartWeek = null;
        selectedChartDay = null;
        const range = chartYearDateRange(selectedChartYear);
        setChartDateRange(range.start, range.end);
        loadDashboard();
        return;
      }
      const monthBar = event.target.closest("[data-chart-month]");
      if (monthBar) {
        selectedChartMonth = Number(monthBar.dataset.chartMonth);
        selectedChartWeek = null;
        selectedChartDay = null;
        const range = chartMonthDateRange(selectedChartYear, selectedChartMonth);
        setChartDateRange(range.start, range.end);
        loadDashboard();
        return;
      }
      const weekBar = event.target.closest("[data-chart-week-start]");
      if (weekBar) {
        selectedChartWeek = {
          start: weekBar.dataset.chartWeekStart,
          end: weekBar.dataset.chartWeekEnd
        };
        selectedChartDay = null;
        setChartDateRange(selectedChartWeek.start, selectedChartWeek.end);
        loadDashboard();
        return;
      }
      const dayBar = event.target.closest("[data-chart-day]");
      if (!dayBar) return;
      selectedChartDay = dayBar.dataset.chartDay;
      setChartDateRange(selectedChartDay, selectedChartDay);
      loadDashboard();
    });
    document.getElementById("area-chart").addEventListener("click", (event) => {
      const target = event.target.closest("[data-area-select]");
      if (!target) return;
      const areaSelect = document.getElementById("area");
      const selectedArea = target.dataset.areaSelect;
      if (!Array.from(areaSelect.options).some((option) => option.value === selectedArea)) {
        const notice = document.getElementById("data-notice");
        notice.classList.add("error");
        notice.textContent = `El área "${selectedArea}" no está disponible en los filtros.`;
        return;
      }
      areaSelect.value = selectedArea;
      activeDetail = "";
      activeReportFilter = {};
      activePage = 1;
      loadDashboard();
    });
    document.getElementById("area-chart-back").addEventListener("click", () => {
      document.getElementById("area").value = "";
      activeDetail = "";
      activeReportFilter = {};
      activePage = 1;
      loadDashboard();
    });
    document.getElementById("chart-back").addEventListener("click", () => {
      if (selectedChartDay !== null) {
        selectedChartDay = null;
        setChartDateRange(selectedChartWeek.start, selectedChartWeek.end);
      } else if (selectedChartWeek !== null) {
        selectedChartWeek = null;
        const range = chartMonthDateRange(selectedChartYear, selectedChartMonth);
        setChartDateRange(range.start, range.end);
      } else if (selectedChartMonth !== null) {
        selectedChartMonth = null;
        const range = chartYearDateRange(selectedChartYear);
        setChartDateRange(range.start, range.end);
      } else if (selectedChartYear !== null) {
        selectedChartYear = null;
        if (chartBaseDateRange) {
          document.getElementById("desde").value = chartBaseDateRange.desde;
          document.getElementById("hasta").value = chartBaseDateRange.hasta;
        }
        chartBaseDateRange = null;
      } else {
        document.getElementById("area").value = "";
      }
      loadDashboard();
    });

    function openReportCell(cell) {
      const row = cell.closest("tr[data-case-detail]");
      if (!row) return;
      const selection = { ...row.dataset, ...cell.dataset };
      activeDetail = selection.caseDetail;
      activePage = 1;
      activeReportFilter = {
        area: selection.caseArea || "",
        gestor: selection.caseDetail === "seguimiento_semanal"
          ? ""
          : selection.caseAdvisor || "",
        asesor_reporte: selection.caseAsesorReporte || "",
        area_emisora: selection.caseAreaEmisora || "",
        gestor_emisor: selection.caseGestorEmisor || "",
        area_salida: selection.caseAreaSalida || "",
        area_destino: selection.caseAreaDestino || "",
        gestor_salida: selection.caseGestorSalida || "",
        asesor_destino: selection.caseAsesorDestino || "",
        reporte_dia: selection.caseReportDay || "",
        reporte_estado: selection.caseReportState || "",
        reporte_desde: selection.caseReportStart || "",
        reporte_hasta: selection.caseReportEnd || "",
      };
      loadCaseDetail().then(() => {
        document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    function openFollowupCase(caseId) {
      activeDetail = "total";
      activeReportFilter = { caso_id: caseId };
      activePage = 1;
      loadCaseDetail().then(() => {
        document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    function openCaseBreakdown(row, cell) {
      rememberCaseDetailReturnState();
      const kind = row.dataset.breakdownKind;
      const caseType = row.dataset.caseType || "";
      const isTotal = row.dataset.breakdownTotal === "true";
      if (caseType) document.getElementById("tipo").value = caseType;

      if (kind === "area-gestion") {
        if (!isTotal && row.dataset.breakdownArea) {
          document.getElementById("area").value = row.dataset.breakdownArea;
          updateAdvisorOptions();
        }
        if (!isTotal && row.dataset.breakdownAdvisor) {
          document.getElementById("gestor").value = row.dataset.breakdownAdvisor;
        }
      } else if (kind === "motivo") {
        const motiveFilter = document.getElementById("motivo");
        const submotiveFilter = document.getElementById("submotivo");
        if (isTotal) {
          motiveFilter.value = "";
          updateClassificationOptions();
          submotiveFilter.value = "";
        } else {
          updateClassificationOptions();
          motiveFilter.value = row.dataset.motive;
          updateClassificationOptions();
          submotiveFilter.value = row.dataset.breakdownLevel === "submotivo"
            ? row.dataset.submotive
            : "";
        }
      } else if (kind === "empresa" || kind === "canal") {
        updateClassificationOptions();
        if (!isTotal) {
          document.getElementById(kind).value = row.dataset.breakdownGroup === "true"
            ? ""
            : row.dataset.categoryValue || "";
        }
      }

      activeDetail = cell.dataset.breakdownState || "total";
      activeReportFilter = {};
      activePage = 1;
      setSidebarView("dashboard");
      loadCaseDetail().then(() => {
        document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    document.querySelectorAll(".area-category-comparison-table, .area-motive-breakdown-table, .area-efficiency-table")
      .forEach((table) => {
        table.addEventListener("click", (event) => {
          const cell = event.target.closest("td[data-case-breakdown]");
          if (cell) openCaseBreakdown(cell.closest("tr"), cell);
        });
        table.addEventListener("keydown", (event) => {
          const cell = event.target.closest("td[data-case-breakdown]");
          if ((event.key === "Enter" || event.key === " ") && cell) {
            event.preventDefault();
            openCaseBreakdown(cell.closest("tr"), cell);
          }
        });
      });

    const areaEfficiencyTable = document.querySelector(".area-efficiency-table");
    areaEfficiencyTable.addEventListener("click", (event) => {
      const areaCell = event.target.closest("td[data-area-filter]");
      if (areaCell) {
        document.getElementById("area").value = areaCell.dataset.areaFilter;
        document.getElementById("gestor").value = "";
        document.getElementById("area").dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      const advisorCell = event.target.closest("td[data-advisor-filter]");
      if (!advisorCell) return;
      selectedAreaEfficiencyAdvisor = advisorCell.dataset.advisorFilter;
      if (latestAreaEfficiencyResult) renderAreaEfficiency(latestAreaEfficiencyResult);
    });
    areaEfficiencyTable.addEventListener("keydown", (event) => {
      const cell = event.target.closest("td[data-area-filter], td[data-advisor-filter]");
      if (cell && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        cell.click();
      }
    });
    document.getElementById("area-efficiency-back").addEventListener("click", () => {
      if (selectedAreaEfficiencyAdvisor) {
        selectedAreaEfficiencyAdvisor = "";
        if (latestAreaEfficiencyResult) renderAreaEfficiency(latestAreaEfficiencyResult);
        return;
      }
      document.getElementById("area").value = "";
      document.getElementById("gestor").value = "";
      document.getElementById("area").dispatchEvent(new Event("change", { bubbles: true }));
    });

    document.getElementById("advisor-week-mode-toggle").addEventListener("change", (event) => {
      advisorWeekMode = event.target.checked ? "monthly" : "weekly";
      if (
        activeRequest
        || !latestAdvisorWeekData
        || !latestAdvisorMonthData
        || (
          advisorWeekMode === "monthly"
          && latestAdvisorMonthData.registros?.length
          && !hasAdvisorMonthWeeks(latestAdvisorMonthData)
        )
      ) {
        loadDashboard(false);
      } else {
        renderAdvisorWeek(latestAdvisorWeekData, latestAdvisorMonthData);
      }
    });

    function refreshAdvisorFlowMode() {
      const monthlyModeActive = advisorReceivedMode === "monthly"
        || advisorDerivedMode === "monthly"
        || advisorOutgoingMode === "monthly";
      if (!monthlyModeActive) {
        if (activeAdvisorFlowRequest) {
          activeAdvisorFlowRequest.abort();
          activeAdvisorFlowRequest = undefined;
        }
        if (latestAdvisorFlowData) renderAdvisorFlowReport(latestAdvisorFlowData);
        return;
      }
      if (activeRequest) {
        loadDashboard(false);
        return;
      }
      if (hasAdvisorFlowMonthData(latestAdvisorFlowData, latestAdvisorMonthData)) {
        if (latestAdvisorFlowData) renderAdvisorFlowReport(latestAdvisorFlowData);
        return;
      }
      if (activeAdvisorFlowRequest || !latestAdvisorFlowData || !latestAdvisorMonthData) {
        if (!activeAdvisorFlowRequest && !activeRequest) loadDashboard(false);
        return;
      }

      const request = new AbortController();
      activeAdvisorFlowRequest = request;
      document.getElementById("advisor-flow-subtitle").textContent =
        "Cargando vista mensual...";
      loadAdvisorFlowMonthData(
        latestAdvisorFlowData,
        latestAdvisorMonthData,
        request.signal
      ).then((result) => {
        if (activeAdvisorFlowRequest !== request) return;
        document.getElementById("data-notice").classList.remove("error");
        renderAdvisorFlowReport(result);
      }).catch((error) => {
        if (error.name === "AbortError") return;
        advisorReceivedMode = "weekly";
        advisorDerivedMode = "weekly";
        advisorOutgoingMode = "weekly";
        if (latestAdvisorFlowData) renderAdvisorFlowReport(latestAdvisorFlowData);
        const notice = document.getElementById("data-notice");
        notice.classList.add("error");
        notice.textContent = error.message || "No se pudo cargar el seguimiento mensual.";
      }).finally(() => {
        if (activeAdvisorFlowRequest === request) {
          activeAdvisorFlowRequest = undefined;
        }
      });
    }

    document.getElementById("advisor-received-mode-toggle").addEventListener("change", (event) => {
      advisorReceivedMode = event.target.checked ? "monthly" : "weekly";
      refreshAdvisorFlowMode();
    });

    document.getElementById("advisor-derived-mode-toggle").addEventListener("change", (event) => {
      advisorDerivedMode = event.target.checked ? "monthly" : "weekly";
      refreshAdvisorFlowMode();
    });

    document.getElementById("advisor-outgoing-mode-toggle").addEventListener("change", (event) => {
      advisorOutgoingMode = event.target.checked ? "monthly" : "weekly";
      refreshAdvisorFlowMode();
    });

    [document.querySelector(".advisor-flow-grid"), document.getElementById("advisor-week-table")]
      .forEach((container) => {
        container.addEventListener("click", (event) => {
          const cell = event.target.closest("td[data-case-number]");
          if (cell) openReportCell(cell);
        });
        container.addEventListener("keydown", (event) => {
          const cell = event.target.closest("td[data-case-number]");
          if (cell && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            cell.click();
          }
        });
      });

    document.addEventListener("click", (event) => {
      const trigger = event.target.closest(".detail-trigger");
      if (!trigger) return;
      activeDetail = trigger.dataset.detail;
      activeReportFilter = {};
      activePage = 1;
      loadCaseDetail().then(() => {
        document.getElementById("cases-title").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    document.getElementById("case-detail-back").addEventListener("click", () => {
      activeDetail = "";
      activeReportFilter = {};
      activePage = 1;
      const returnScrollY = caseDetailReturnScrollY;
      const returnView = caseDetailReturnView;
      const returnFilters = caseDetailReturnFilters;
      caseDetailReturnScrollY = null;
      caseDetailReturnView = "dashboard";
      caseDetailReturnFilters = null;
      restoreCaseDetailReturnFilters(returnFilters);
      loadDashboard().then(() => {
        setSidebarView(returnView);
        if (returnScrollY !== null) {
          window.scrollTo({ top: returnScrollY, behavior: "smooth" });
        }
      });
    });
    document.getElementById("detail-prev").addEventListener("click", () => {
      if (activePage > 1) {
        activePage -= 1;
        loadCaseDetail();
      }
    });
    document.getElementById("detail-next").addEventListener("click", () => {
      activePage += 1;
      loadCaseDetail();
    });
    const textDialog = document.getElementById("case-text-dialog");
    function showRecordAlerts(record) {
      if (!record) return;
      const alerts = String(record["ALERTA CAMPOS VACÍOS"] || "SIN ALERTA")
        .split(" | ")
        .map((alert) => alert.trim())
        .filter(Boolean);
      document.getElementById("case-text-title").textContent =
        `Alertas del caso · ID ${record["ID CASO"] || "—"}`;
      document.getElementById("case-text-content").textContent = alerts.join("\n");
      textDialog.showModal();
    }

    document.getElementById("followup-body").addEventListener("click", (event) => {
      const detailTrigger = event.target.closest(".followup-detail-button");
      if (detailTrigger) {
        openFollowupCase(detailTrigger.dataset.followupCaseId);
        return;
      }
      const recordTrigger = event.target.closest(".followup-record-view-button");
      if (recordTrigger) {
        showRecordAlerts(displayedFollowupCases[Number(recordTrigger.dataset.caseIndex)]);
        return;
      }
    });

    document.getElementById("cases-table").addEventListener("click", (event) => {
      const recordTrigger = event.target.closest(".record-view-button");
      if (recordTrigger) {
        showRecordAlerts(displayedCases[Number(recordTrigger.dataset.caseIndex)]);
        return;
      }
      const dniTrigger = event.target.closest(".dni-filter-button");
      if (dniTrigger) {
        openDniCases(dniTrigger.dataset.caseDni);
        return;
      }
      const trigger = event.target.closest(".text-view-button");
      if (!trigger) return;
      document.getElementById("case-text-title").textContent = trigger.dataset.textColumn;
      document.getElementById("case-text-content").textContent = trigger.dataset.fullText;
      textDialog.showModal();
    });
    document.getElementById("case-text-close").addEventListener("click", () => textDialog.close());
    textDialog.addEventListener("click", (event) => {
      if (event.target === textDialog) textDialog.close();
    });

    document.getElementById("sidebar-toggle").addEventListener("click", (event) => {
      const button = event.currentTarget;
      const collapsed = document.getElementById("app-layout").classList.toggle("sidebar-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute(
        "aria-label",
        collapsed ? "Expandir barra lateral" : "Contraer barra lateral"
      );
      button.title = collapsed ? "Expandir barra lateral" : "Contraer barra lateral";
    });
    const desktopViewButton = document.getElementById("desktop-view-toggle");
    const desktopViewEnabled = document.documentElement.classList.contains("desktop-view-mode");
    const desktopViewLabel = desktopViewEnabled ? "Volver a vista móvil" : "Ver sitio para computadoras";
    desktopViewButton.querySelector(".desktop-view-toggle-label").textContent = desktopViewEnabled ? "Móvil" : "PC";
    desktopViewButton.setAttribute("aria-pressed", String(desktopViewEnabled));
    desktopViewButton.setAttribute("aria-label", desktopViewLabel);
    desktopViewButton.title = desktopViewLabel;
    desktopViewButton.addEventListener("click", () => {
      const url = new URL(window.location.href);
      if (desktopViewEnabled) url.searchParams.delete("view");
      else url.searchParams.set("view", "desktop");
      window.location.assign(url.href);
    });
    const dashboardNav = document.getElementById("dashboard-nav");
    const advisorsNav = document.getElementById("advisors-nav");
    const setSidebarView = (view) => {
      const showAdvisors = view === "advisors";
      document.getElementById("main-content").classList.toggle("advisor-view-active", showAdvisors);
      dashboardNav.classList.toggle("sidebar-link-current", !showAdvisors);
      advisorsNav.classList.toggle("sidebar-link-current", showAdvisors);
      if (showAdvisors) {
        dashboardNav.removeAttribute("aria-current");
        advisorsNav.setAttribute("aria-current", "page");
      } else {
        advisorsNav.removeAttribute("aria-current");
        dashboardNav.setAttribute("aria-current", "page");
      }
    };
    dashboardNav.addEventListener("click", () => setSidebarView("dashboard"));
    advisorsNav.addEventListener("click", () => setSidebarView("advisors"));
    loadDashboard();
    window.setInterval(() => {
      if (!document.hidden) loadDashboard(false);
    }, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadDashboard(false);
    });
