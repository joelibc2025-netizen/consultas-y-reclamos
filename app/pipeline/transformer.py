from datetime import date, datetime, timedelta
from numbers import Real
from typing import IO

import pandas as pd

BASE_EXCEL = date(1899, 12, 30)
MIN_FECHA = date(2020, 1, 1)

BD_FINAL_COLUMNS = (
    "ID CASO",
    "FECHA INGRESO",
    "GESTOR",
    "ÁREA INICIAL",
    "TIPO CASO",
    "DNI",
    "CLIENTE",
    "MOTIVO",
    "SUBMOTIVO",
    "FECHA CIERRE",
    "CONDICIÓN USUARIO",
    "ÁREA DERIVADA",
    "FECHA RECEPCIÓN",
    "RESPONSABLE DESTINO",
    "ATENCIÓN BRINDADA",
    "TIPO DE CASO DERIVADO",
    "MOTIVO DERIVADO",
    "SUBMOTIVO DERIVADO",
    "CONDICIÓN FINAL USUARIO",
    "FECHA FINAL",
    "ALERTA CAMPOS VACÍOS",
    "DÍAS TRANSCURRIDOS",
    "DÍAS RECEPCIÓN DE DERIVADO",
    "ALERTA TIEMPO",
    "ALERTA SOLUCIÓN",
    "TIPO CASO FINAL",
    "MOTIVO FINAL",
    "SUBMOTIVO FINAL",
    "ÁREA FINAL",
    "ASESOR FINAL",
    "EMPRESA",
    "CANAL",
    "ROL DEL ÁREA",
    "CLASIFICACIÓN PARA TOTAL INGRESADOS",
    "ÁREA QUE SUMA EL INGRESO",
    "ÁREA DE SALIDA",
    "SUMA TOTAL INGRESADOS",
    "SUMA CASOS SALIENTES",
    "REGLA DE CONTEO",
    "VALIDACIÓN DE DERIVACIÓN",
    "ESTADO DE CALIDAD DEL REGISTRO",
    "REGISTRO APTO PARA REPORTES",
    "DETALLE DEL MOTIVO (VERSION DEL USUARIO)",
)


def vacio(value: object) -> bool:
    if value is None:
        return True
    try:
        if pd.isna(value):
            return True
    except (TypeError, ValueError):
        pass
    return isinstance(value, str) and value == ""


def limpiar(value: object) -> str:
    return " ".join(str(value).replace("\u00a0", " ").split()) if not vacio(value) else ""


def normalizar(value: object) -> str:
    return limpiar(value).upper()


def fecha(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, Real) and not isinstance(value, bool):
        return BASE_EXCEL + timedelta(days=int(value))
    return None


def fecha_valida(value: object) -> bool:
    parsed = fecha(value)
    return parsed is not None and parsed >= MIN_FECHA


def letra_columna(index: int) -> str:
    column = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        column = chr(ord("A") + remainder) + column
    return column


def bd_final_fila(src: dict[str, object], id_caso: int, hoy: date) -> dict[str, object]:
    def get_source(column: str) -> object:
        value = src.get(column)
        return "" if vacio(value) else value

    row: dict[str, object] = {
        "A": id_caso,
        "B": get_source("D"),
        "C": get_source("B"),
        "D": get_source("C"),
        "E": get_source("G"),
        "F": get_source("H"),
        "G": get_source("I"),
        "H": get_source("M"),
        "I": get_source("N"),
        "J": get_source("R"),
        "K": get_source("S"),
        "L": get_source("T"),
        "M": get_source("U"),
        "N": get_source("V"),
        "O": get_source("Z"),
        "P": get_source("W") if not vacio(get_source("W")) else "NO CLASIFICADO",
        "Q": get_source("X"),
        "R": get_source("Y"),
        "S": get_source("AB"),
        "T": get_source("AA"),
        "AQ": get_source("O"),
    }

    condition = row["K"]
    destination = row["L"]
    origin = row["D"]
    final_condition = row["S"]
    destination_normalized = normalizar(destination)
    origin_normalized = normalizar(origin)

    warnings = []
    if vacio(row["H"]):
        warnings.append("SIN MOTIVO")
    if vacio(row["I"]):
        warnings.append("SIN SUBMOTIVO")
    if vacio(condition):
        warnings.append("SIN CONDICIÓN")
    if condition == "CERRADO" and not fecha_valida(row["J"]):
        warnings.append("CERRADO | SIN FECHA DE CIERRE")
    if condition == "PENDIENTE":
        warnings.append("PENDIENTE DE CIERRE O DERIVACIÓN")
    if condition == "DERIVADO":
        if vacio(destination):
            warnings.append("SIN ÁREA DERIVADA")
        if not fecha_valida(row["M"]):
            warnings.append("SIN FECHA RECEPCIÓN")
        if vacio(row["N"]):
            warnings.append("SIN RESPONSABLE DE ATENCIÓN")
        if row["P"] in ("", "NO CLASIFICADO"):
            warnings.append("SIN TIPO DE CASO DERIVADO")
        if vacio(row["Q"]):
            warnings.append("SIN MOTIVO DERIVADO")
        if vacio(row["R"]):
            warnings.append("SIN SUBMOTIVO DERIVADO")
        if final_condition in ("", "PENDIENTE"):
            warnings.append("PENDIENTE DE ATENCIÓN")
        if final_condition == "ATENDIDO" and not fecha_valida(row["T"]):
            warnings.append("ATENDIDO | SIN FECHA FINAL")
    row["U"] = " | ".join(warnings) if warnings else "COMPLETO"

    start_date = fecha(row["B"]) if fecha_valida(row["B"]) else None
    end_date = next((fecha(row[key]) for key in ("T", "J") if fecha_valida(row[key])), hoy)
    row["V"] = max(0, (end_date - start_date).days) if start_date else "SIN FECHA DE INGRESO"

    if condition != "DERIVADO":
        row["W"] = "NO ES DERIVADO"
    elif not start_date:
        row["W"] = "SIN FECHA DE INGRESO"
    else:
        reception_date = fecha(row["M"]) if fecha_valida(row["M"]) else hoy
        row["W"] = max(0, (reception_date - start_date).days)

    elapsed_days = row["V"] if isinstance(row["V"], int) else 0
    row["X"] = (
        "VENCIDO > 7 DÍAS"
        if elapsed_days > 7
        else "ALERTA 3-7 DÍAS"
        if elapsed_days >= 3
        else "EN PLAZO"
    )
    row["Y"] = (
        "SOLUCIONADO"
        if condition == "CERRADO" or (condition == "DERIVADO" and final_condition == "ATENDIDO")
        else "NO SOLUCIONADO"
    )

    derived_type = normalizar(row["P"])
    case_type = (
        derived_type
        if condition == "DERIVADO" and derived_type not in ("", "NO CLASIFICADO")
        else normalizar(row["E"])
    )
    row["Z"] = (
        "CONSULTA"
        if case_type in ("CONSULTA", "CONSULTAS")
        else "RECLAMO"
        if case_type in ("RECLAMO", "RECLAMOS")
        else case_type
    )
    row["AA"] = row["Q"] if condition == "DERIVADO" and limpiar(row["Q"]) else row["H"]
    row["AB"] = row["R"] if condition == "DERIVADO" and limpiar(row["R"]) else row["I"]
    row["AC"] = destination if limpiar(destination) else origin
    row["AD"] = (
        row["N"]
        if limpiar(row["N"])
        else "SIN RESPONSABLE"
        if normalizar(condition) == "DERIVADO" and limpiar(destination)
        else row["C"]
        if limpiar(row["C"])
        else ""
    )
    row["AE"] = get_source("K")
    row["AF"] = normalizar(get_source("F"))

    is_outgoing = bool(destination_normalized and destination_normalized != origin_normalized)
    row["AG"] = "CASO DERIVADO" if limpiar(destination) else "CASO RECIBIDO"
    row["AH"] = (
        "RECIBIDO DERIVADO POR OTRA ÁREA" if is_outgoing else "RECIBIDO NO DERIVADO"
    )
    row["AI"] = destination if limpiar(destination) else origin
    row["AJ"] = origin if is_outgoing else ""
    row["AK"] = 1
    row["AL"] = int(is_outgoing)
    row["AM"] = (
        "SUMA COMO RECIBIDO NO DERIVADO EN ÁREA INICIAL"
        if not destination_normalized
        else "REGISTRO DERIVADO CON ORIGEN Y DESTINO IGUALES: REVISAR"
        if destination_normalized == origin_normalized
        else "SUMA COMO RECIBIDO DERIVADO EN ÁREA DESTINO; "
        "NO SUMA COMO INGRESO EN ÁREA ORIGEN"
    )
    row["AN"] = (
        "REVISAR: ORIGEN Y DESTINO IGUALES"
        if destination_normalized and destination_normalized == origin_normalized
        else "OK"
    )
    row["AO"] = (
        "REVISAR: FECHA INGRESO"
        if fecha(row["B"]) is None
        else "REVISAR: ÁREA INICIAL"
        if not limpiar(origin)
        else "REVISAR: DERIVADO SIN DESTINO"
        if normalizar(condition) == "DERIVADO" and not limpiar(destination)
        else row["AN"]
        if row["AN"] != "OK"
        else "OK"
    )
    row["AP"] = int(row["AO"] == "OK")
    return row


def procesar_atencion_a_bd_final(file_path: str | IO[bytes]) -> pd.DataFrame:
    source = pd.read_excel(
        file_path,
        sheet_name="ATENCION Y GESTION",
        header=4,
    )
    today = date.today()
    source_rows = (
        {
            letra_columna(column_index + 1): value
            for column_index, value in enumerate(values)
        }
        for values in source.itertuples(index=False, name=None)
    )
    records = [
        bd_final_fila(source_row, case_id, today)
        for case_id, source_row in enumerate(source_rows, start=1)
    ]
    return pd.DataFrame(
        ({column_name: record[letra_columna(index + 1)] for index, column_name in enumerate(BD_FINAL_COLUMNS)}
         for record in records),
        columns=BD_FINAL_COLUMNS,
    )
