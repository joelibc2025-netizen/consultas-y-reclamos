import sqlite3

import pandas as pd


_GROUP_METRICS = """
    SUM(quantity),
    SUM(CASE WHEN solved = 1 THEN quantity ELSE 0 END),
    SUM(CASE WHEN unsolved = 1 THEN quantity ELSE 0 END),
    SUM(CASE WHEN days IS NOT NULL AND quantity > 0 THEN days * quantity ELSE 0 END)
        / NULLIF(SUM(CASE WHEN days IS NOT NULL AND quantity > 0 THEN quantity ELSE 0 END), 0),
    SUM(CASE WHEN days IS NOT NULL AND quantity > 0 AND solved = 1 THEN days * quantity ELSE 0 END)
        / NULLIF(SUM(CASE WHEN days IS NOT NULL AND quantity > 0 AND solved = 1 THEN quantity ELSE 0 END), 0),
    SUM(CASE WHEN days IS NOT NULL AND quantity > 0 AND unsolved = 1 THEN days * quantity ELSE 0 END)
        / NULLIF(SUM(CASE WHEN days IS NOT NULL AND quantity > 0 AND unsolved = 1 THEN quantity ELSE 0 END), 0),
    MIN(source_order)
"""


def _grouped_metrics(
    connection: sqlite3.Connection,
    columns: str,
) -> dict[tuple[str, ...], tuple[int, int, int, float | None, float | None, float | None, int]]:
    rows = connection.execute(
        f"""
        SELECT {columns}, {_GROUP_METRICS}
        FROM motive_rows
        GROUP BY {columns}
        """
    )
    grouped = {}
    for row in rows:
        key = tuple(str(value) for value in row[: len(columns.split(","))])
        values = row[len(key):]
        grouped[key] = (
            int(values[0] or 0),
            int(values[1] or 0),
            int(values[2] or 0),
            float(values[3]) if values[3] is not None else None,
            float(values[4]) if values[4] is not None else None,
            float(values[5]) if values[5] is not None else None,
            int(values[6]),
        )
    return grouped


def _format_metrics(
    metrics: tuple[int, int, int, float | None, float | None, float | None, int],
    type_total: int,
) -> dict[str, object]:
    total, solved, unsolved, average, solved_average, unsolved_average, _ = metrics
    return {
        "total": total,
        "porcentaje_total": total * 100 / type_total if type_total else None,
        "promedio_dias": average,
        "solucionados": solved,
        "porcentaje_solucionados": solved * 100 / total if total else None,
        "promedio_dias_solucionados": solved_average,
        "no_solucionados": unsolved,
        "porcentaje_no_solucionados": unsolved * 100 / total if total else None,
        "promedio_dias_no_solucionados": unsolved_average,
    }


def resumir_motivos_sql(
    motive_cases: pd.DataFrame,
) -> tuple[dict[str, list[dict[str, object]]], dict[str, dict[str, object]]]:
    breakdown: dict[str, list[dict[str, object]]] = {
        "CONSULTA": [],
        "RECLAMO": [],
    }
    totals: dict[str, dict[str, object]] = {}
    columns = [
        "_tipo_motivo",
        "_motivo",
        "_submotivo",
        "_cantidad_motivo",
        "_dias_motivo",
        "_solucionado_motivo",
        "_no_solucionado_motivo",
    ]
    rows = (
        (
            str(kind),
            str(motive),
            str(submotive),
            float(quantity),
            None if pd.isna(days) else float(days),
            int(solved),
            int(unsolved),
            order,
        )
        for order, (
            kind,
            motive,
            submotive,
            quantity,
            days,
            solved,
            unsolved,
        ) in enumerate(motive_cases[columns].itertuples(index=False, name=None))
    )

    with sqlite3.connect(":memory:") as connection:
        connection.execute(
            """
            CREATE TABLE motive_rows (
                kind TEXT NOT NULL,
                motive TEXT NOT NULL,
                submotive TEXT NOT NULL,
                quantity REAL NOT NULL,
                days REAL,
                solved INTEGER NOT NULL,
                unsolved INTEGER NOT NULL,
                source_order INTEGER NOT NULL
            )
            """
        )
        connection.executemany(
            "INSERT INTO motive_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        type_metrics = _grouped_metrics(connection, "kind")
        motive_metrics = _grouped_metrics(connection, "kind, motive")
        submotive_metrics = _grouped_metrics(connection, "kind, motive, submotive")

    empty_metrics = (0, 0, 0, None, None, None, 0)
    for case_type in breakdown:
        total_metrics = type_metrics.get((case_type,), empty_metrics)
        type_total = total_metrics[0]
        totals[case_type] = _format_metrics(total_metrics, type_total)

        motives = [
            (key[1], metrics)
            for key, metrics in motive_metrics.items()
            if key[0] == case_type
        ]
        motives.sort(key=lambda item: (-item[1][0], item[1][6]))
        for motive, metrics in motives:
            breakdown[case_type].append({
                "nivel": "motivo",
                "motivo": motive,
                "submotivo": "",
                **_format_metrics(metrics, type_total),
            })
            submotives = [
                (key[2], submetrics)
                for key, submetrics in submotive_metrics.items()
                if key[0] == case_type
                and key[1] == motive
                and key[2] != "NO TIENE SUBMOTIVO"
            ]
            submotives.sort(key=lambda item: (-item[1][0], item[1][6]))
            breakdown[case_type].extend(
                {
                    "nivel": "submotivo",
                    "motivo": motive,
                    "submotivo": submotive,
                    **_format_metrics(submetrics, type_total),
                }
                for submotive, submetrics in submotives
            )

    return breakdown, totals
