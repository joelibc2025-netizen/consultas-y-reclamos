from datetime import date, datetime, timedelta
import hmac
from io import BytesIO
import logging
import os
from pathlib import Path
import tempfile
from threading import Lock
from time import monotonic
from typing import IO
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zipfile import BadZipFile

import pandas as pd
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.pipeline.transformer import procesar_atencion_a_bd_final
from app.sql_aggregates import resumir_motivos_sql

app = FastAPI(title="Dashboard de Gestión de Consultas y Reclamos", version="1.0")
logger = logging.getLogger(__name__)

PROJECT_DIR = Path(__file__).resolve().parent.parent
EXCEL_PATH = PROJECT_DIR / "PROTOTIPO DE GESTION DE CONSULTAS Y RECLAMOS.xlsx"
UPLOAD_DIR = PROJECT_DIR / "data"
ACTIVE_UPLOAD_PATH = UPLOAD_DIR / "ATENCION Y GESTION.xlsx"
STATIC_DIR = PROJECT_DIR / "static"
_cases_cache: pd.DataFrame | None = None
_cases_cache_asof: date | None = None
_cases_refresh_after: float | None = None
_cases_source = "respaldo local"
_cases_source_warning: str | None = None
_cases_uploaded_filename: str | None = None
_cases_source_updated_at: str | None = None
_cases_source_version = 0
_cases_refresh_lock = Lock()
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
SOURCE_SHEET = "ATENCION Y GESTION"
SOURCE_REFRESH_INTERVAL_SECONDS = 5 * 60
SOURCE_DOWNLOAD_TIMEOUT_SECONDS = 30

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class SharePointSourceError(Exception):
    pass


def preparar_casos(file_path: str | IO[bytes]) -> pd.DataFrame:
    cases = procesar_atencion_a_bd_final(file_path)
    cases.columns = cases.columns.astype(str).str.strip().str.upper()
    for column in ("FECHA INGRESO", "FECHA RECEPCIÓN", "FECHA CIERRE", "FECHA FINAL"):
        if column in cases.columns:
            cases[column] = pd.to_datetime(cases[column], errors="coerce")
    cases["_CONDICION_USUARIO_LIMPIA"] = limpiar_columna(cases["CONDICIÓN USUARIO"])
    cases["_CONDICION_FINAL_LIMPIA"] = limpiar_columna(cases["CONDICIÓN FINAL USUARIO"])
    cases["_AREA_INICIAL_LIMPIA"] = limpiar_columna(cases["ÁREA INICIAL"]).str.upper()
    cases["_AREA_DERIVADA_LIMPIA"] = limpiar_columna(cases["ÁREA DERIVADA"]).str.upper()
    return cases


def preparar_excel(content: bytes) -> pd.DataFrame:
    if not content:
        raise SharePointSourceError("El archivo Excel está vacío.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise SharePointSourceError("El archivo Excel supera el límite de 50 MB.")

    try:
        with pd.ExcelFile(BytesIO(content)) as workbook:
            if SOURCE_SHEET not in workbook.sheet_names:
                raise SharePointSourceError(
                    f"El archivo debe contener la hoja '{SOURCE_SHEET}'."
                )
        cases = preparar_casos(BytesIO(content))
    except SharePointSourceError:
        raise
    except (BadZipFile, KeyError, OSError, TypeError, ValueError) as error:
        raise SharePointSourceError(
            "El archivo Excel está dañado o no tiene el formato esperado."
        ) from error

    if cases.empty:
        raise SharePointSourceError("La hoja no contiene registros para procesar.")
    return cases


def guardar_respaldo_excel(content: bytes) -> None:
    temporary_path: Path | None = None
    try:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=UPLOAD_DIR,
            prefix=".excel-",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
            temporary_path = Path(temporary_file.name)
        os.replace(temporary_path, ACTIVE_UPLOAD_PATH)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def descargar_casos_sharepoint() -> tuple[pd.DataFrame, bytes]:
    url = os.environ.get("SHAREPOINT_EXCEL_URL", "").strip()
    if not url:
        raise SharePointSourceError(
            "SharePoint no está configurado. Define la variable SHAREPOINT_EXCEL_URL."
        )

    parsed_url = urlparse(url)
    hostname = (parsed_url.hostname or "").lower()
    if parsed_url.scheme != "https" or not (
        hostname == "sharepoint.com" or hostname.endswith(".sharepoint.com")
    ):
        raise SharePointSourceError(
            "SHAREPOINT_EXCEL_URL debe ser un enlace HTTPS de SharePoint."
        )

    request = Request(url, headers={"User-Agent": "DashboardConsultasReclamos/1.0"})
    try:
        with urlopen(request, timeout=SOURCE_DOWNLOAD_TIMEOUT_SECONDS) as response:
            content = response.read(MAX_UPLOAD_BYTES + 1)
    except HTTPError as error:
        if error.code in (401, 403):
            raise SharePointSourceError(
                f"SharePoint denegó el acceso (HTTP {error.code}). "
                "El enlace debe permitir la descarga directa; si requiere iniciar sesión, "
                "se necesita configurar autenticación de Microsoft."
            ) from error
        raise SharePointSourceError(
            f"SharePoint respondió con el estado HTTP {error.code}."
        ) from error
    except (OSError, TimeoutError, URLError) as error:
        raise SharePointSourceError("No se pudo conectar con SharePoint.") from error

    cases = preparar_excel(content)
    return cases, content


def cargar_respaldo_local() -> tuple[pd.DataFrame, Path]:
    for source_path in (ACTIVE_UPLOAD_PATH, EXCEL_PATH):
        if not source_path.is_file():
            continue
        try:
            return preparar_excel(source_path.read_bytes()), source_path
        except (OSError, SharePointSourceError):
            continue
    raise HTTPException(
        status_code=503,
        detail="SharePoint no está disponible y no se encontró un respaldo Excel válido.",
    )


def obtener_casos() -> pd.DataFrame:
    global _cases_cache, _cases_cache_asof, _cases_refresh_after
    global _cases_source, _cases_source_warning, _cases_uploaded_filename
    global _cases_source_updated_at, _cases_source_version

    today = date.today()
    now = monotonic()
    if (
        _cases_cache is not None
        and _cases_refresh_after is not None
        and now < _cases_refresh_after
        and _cases_cache_asof == today
    ):
        return _cases_cache

    with _cases_refresh_lock:
        now = monotonic()
        if (
            _cases_cache is not None
            and _cases_refresh_after is not None
            and now < _cases_refresh_after
            and _cases_cache_asof == today
        ):
            return _cases_cache

        try:
            cases, content = descargar_casos_sharepoint()
            guardar_respaldo_excel(content)
        except SharePointSourceError as error:
            logger.warning("No se pudo actualizar la fuente SharePoint: %s", error)
            bridge_only_mode = (
                not os.environ.get("SHAREPOINT_EXCEL_URL", "").strip()
                and bool(os.environ.get("DASHBOARD_SYNC_TOKEN", "").strip())
            )
            if _cases_cache is None or _cases_cache_asof != today:
                try:
                    _cases_cache, source_path = cargar_respaldo_local()
                except HTTPException as backup_error:
                    raise HTTPException(
                        status_code=503,
                        detail=f"{error} {backup_error.detail}",
                    ) from error
                _cases_source = (
                    "sincronizado desde PC"
                    if bridge_only_mode and source_path == ACTIVE_UPLOAD_PATH
                    else "respaldo local"
                )
                _cases_uploaded_filename = (
                    source_path.name if source_path == ACTIVE_UPLOAD_PATH else None
                )
                _cases_source_updated_at = datetime.fromtimestamp(
                    source_path.stat().st_mtime
                ).astimezone().isoformat(timespec="seconds")
                _cases_source_version += 1
            _cases_source_warning = None if (
                bridge_only_mode and _cases_source == "sincronizado desde PC"
            ) else f"{error} Se muestran los datos disponibles de {_cases_source}."
        except OSError as error:
            logger.error("No se pudo guardar el respaldo local de SharePoint.")
            if _cases_cache is None or _cases_cache_asof != today:
                try:
                    _cases_cache, source_path = cargar_respaldo_local()
                except HTTPException as backup_error:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "No se pudo guardar el respaldo local de SharePoint. "
                            f"{backup_error.detail}"
                        ),
                    ) from error
                _cases_source = "respaldo local"
                _cases_uploaded_filename = (
                    source_path.name if source_path == ACTIVE_UPLOAD_PATH else None
                )
                _cases_source_updated_at = datetime.fromtimestamp(
                    source_path.stat().st_mtime
                ).astimezone().isoformat(timespec="seconds")
                _cases_source_version += 1
            _cases_source_warning = (
                "No se pudo guardar el respaldo local de SharePoint. "
                f"Se muestran los datos disponibles de {_cases_source}."
            )
        else:
            _cases_cache = cases
            _cases_source = "SharePoint"
            _cases_source_warning = None
            _cases_uploaded_filename = None
            _cases_source_updated_at = datetime.now().astimezone().isoformat(
                timespec="seconds"
            )
            _cases_source_version += 1

        _cases_cache_asof = today
        _cases_refresh_after = monotonic() + SOURCE_REFRESH_INTERVAL_SECONDS

    if _cases_cache is None:
        raise HTTPException(
            status_code=503,
            detail="No hay datos válidos disponibles para mostrar.",
        )
    return _cases_cache


def texto_limpio(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def limpiar_columna(columna: pd.Series) -> pd.Series:
    return (
        columna.astype("string")
        .fillna("")
        .str.replace("\u00a0", " ", regex=False)
        .str.strip()
    )


def columna_limpia(
    frame: pd.DataFrame,
    column: str,
    cached_column: str,
) -> pd.Series:
    if cached_column in frame.columns:
        return frame[cached_column]
    return limpiar_columna(frame[column])


def clasificar_estado_eficiencia(total: int, eficiencia: float | None) -> str:
    if total == 0:
        return "--"
    if eficiencia is None or eficiencia <= 70:
        return "MALO"
    if eficiencia < 90:
        return "REGULAR"
    return "ÓPTIMO"


def mascara_solucionada(df: pd.DataFrame) -> pd.Series:
    condicion_usuario = columna_limpia(
        df, "CONDICIÓN USUARIO", "_CONDICION_USUARIO_LIMPIA"
    )
    return condicion_usuario.eq("CERRADO") | estados_condicion_final(df).eq("atendido")


def mascara_no_solucionada(df: pd.DataFrame) -> pd.Series:
    condicion_usuario = columna_limpia(
        df, "CONDICIÓN USUARIO", "_CONDICION_USUARIO_LIMPIA"
    )
    estado_final = estados_condicion_final(df)
    return condicion_usuario.isin({"PENDIENTE", ""}) | estado_final.isin(
        {"pendiente", "sin_condicion"}
    )


def estados_condicion_final(df: pd.DataFrame) -> pd.Series:
    condicion_final = columna_limpia(
        df, "CONDICIÓN FINAL USUARIO", "_CONDICION_FINAL_LIMPIA"
    )
    es_derivado = columna_limpia(
        df, "CONDICIÓN USUARIO", "_CONDICION_USUARIO_LIMPIA"
    ).eq("DERIVADO")
    estados = condicion_final.map({
        "ATENDIDO": "atendido",
        "PENDIENTE": "pendiente",
        "": "sin_condicion",
    })
    return estados.where(es_derivado)


def mascara_derivado_por_area(df: pd.DataFrame) -> pd.Series:
    area_origen = columna_limpia(
        df, "ÁREA INICIAL", "_AREA_INICIAL_LIMPIA"
    )
    area_destino = columna_limpia(
        df, "ÁREA DERIVADA", "_AREA_DERIVADA_LIMPIA"
    )
    return area_destino.ne("") & area_destino.ne(area_origen)


def fechas_como_date(columna: pd.Series) -> pd.Series:
    return columna.dt.date.astype("object")


def distribucion(
    df: pd.DataFrame,
    column: str,
    limit: int | None = 8,
) -> list[dict[str, object]]:
    if column not in df.columns:
        return []

    counts = df[column].fillna("").astype(str).str.strip()
    counts = counts[counts.ne("")].value_counts()
    if limit is not None:
        counts = counts.head(limit)
    return [{"nombre": str(name), "cantidad": int(count)} for name, count in counts.items()]


def suma_columna(df: pd.DataFrame, column: str, mask: pd.Series | None = None) -> int:
    if column not in df.columns:
        return 0
    values = pd.to_numeric(df[column], errors="coerce").fillna(0)
    if mask is not None:
        values = values[mask]
    return int(values.sum())


def resumir_flujos(
    df: pd.DataFrame,
    origin_column: str,
    destination_column: str,
    count_column: str,
) -> list[dict[str, object]]:
    if df.empty:
        return []

    work = df.assign(
        _origen=df[origin_column].fillna("").astype(str).str.strip(),
        _destino=df[destination_column].fillna("").astype(str).str.strip(),
        _asesor_origen=df["GESTOR"].fillna("").astype(str).str.strip(),
        _asesor_destino=df["RESPONSABLE DESTINO"].fillna("").astype(str).str.strip(),
        _cantidad=pd.to_numeric(df[count_column], errors="coerce").fillna(0),
    )
    solved = mascara_solucionada(df)
    work["_solucionados"] = work["_cantidad"].where(solved, 0)
    work["_no_solucionados"] = work["_cantidad"].where(mascara_no_solucionada(df), 0)

    flows = []
    for (origin, destination), group in work.groupby(
        ["_origen", "_destino"], dropna=False, sort=False
    ):
        advisor_groups = (
            group.groupby(["_asesor_origen", "_asesor_destino"], dropna=False)
            .agg(
                total=("_cantidad", "sum"),
                solucionados=("_solucionados", "sum"),
                no_solucionados=("_no_solucionados", "sum"),
            )
            .sort_values("total", ascending=False)
        )
        flows.append({
            "origen": origin or "Origen no especificado",
            "destino": destination or "Destino no especificado",
            "total": int(group["_cantidad"].sum()),
            "solucionados": int(group["_solucionados"].sum()),
            "no_solucionados": int(group["_no_solucionados"].sum()),
            "asesores": [
                {
                    "origen": advisor_origin or "Asesor no especificado",
                    "destino": advisor_destination or "Responsable no especificado",
                    "total": int(row["total"]),
                    "solucionados": int(row["solucionados"]),
                    "no_solucionados": int(row["no_solucionados"]),
                }
                for (advisor_origin, advisor_destination), row in advisor_groups.iterrows()
            ],
        })

    return sorted(flows, key=lambda flow: flow["total"], reverse=True)


def opciones_columna(df: pd.DataFrame, column: str) -> list[str]:
    if column not in df.columns:
        return []
    return sorted(
        value
        for value in df[column].dropna().astype(str).str.strip().unique().tolist()
        if value
    )


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


async def procesar_carga_excel(
    archivo: UploadFile,
    fuente: str,
) -> dict[str, object]:
    global _cases_cache, _cases_cache_asof, _cases_refresh_after
    global _cases_source, _cases_source_warning, _cases_uploaded_filename
    global _cases_source_updated_at, _cases_source_version

    filename = (archivo.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if Path(filename).suffix.lower() not in (".xlsx", ".xlsm"):
        raise HTTPException(status_code=400, detail="Selecciona un archivo .xlsx o .xlsm.")

    content = await archivo.read(MAX_UPLOAD_BYTES + 1)
    await archivo.close()
    if not content:
        raise HTTPException(status_code=400, detail="El archivo está vacío.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="El archivo supera el límite de 50 MB.")

    try:
        uploaded_cases = preparar_excel(content)
    except SharePointSourceError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    try:
        with _cases_refresh_lock:
            guardar_respaldo_excel(content)
            _cases_cache = uploaded_cases
            _cases_cache_asof = date.today()
            _cases_refresh_after = monotonic() + SOURCE_REFRESH_INTERVAL_SECONDS
            _cases_source = fuente
            _cases_source_warning = None
            _cases_uploaded_filename = filename
            _cases_source_updated_at = datetime.now().astimezone().isoformat(
                timespec="seconds"
            )
            _cases_source_version += 1
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail="No se pudo guardar permanentemente el archivo cargado.",
        ) from error
    dates = uploaded_cases["FECHA INGRESO"].dropna()
    return {
        "archivo": filename,
        "archivo_cargado": ACTIVE_UPLOAD_PATH.name,
        "registros": len(uploaded_cases),
        "desde": dates.min().date().isoformat() if not dates.empty else None,
        "hasta": dates.max().date().isoformat() if not dates.empty else None,
    }


@app.post("/api/cargar-excel")
async def cargar_excel(archivo: UploadFile = File(...)) -> dict[str, object]:
    return await procesar_carga_excel(archivo, "archivo cargado manualmente")


@app.post("/api/sincronizar-excel")
async def sincronizar_excel(
    archivo: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    configured_token = os.environ.get("DASHBOARD_SYNC_TOKEN", "")
    if not configured_token:
        raise HTTPException(
            status_code=503,
            detail="La sincronización desde PC no está configurada en este servidor.",
        )

    scheme, separator, supplied_token = (authorization or "").partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not hmac.compare_digest(
            supplied_token.encode("utf-8"),
            configured_token.encode("utf-8"),
        )
    ):
        raise HTTPException(
            status_code=401,
            detail="Token de sincronización inválido o ausente.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return await procesar_carga_excel(archivo, "sincronizado desde PC")


@app.get("/api/dashboard")
def obtener_dashboard(
    desde: date | None = None,
    hasta: date | None = None,
    area_desde: date | None = None,
    area_hasta: date | None = None,
    area: str = "",
    gestor: str = "",
    tipo: str = "",
    motivo: str = "",
    submotivo: str = "",
    empresa: str = "",
    canal: str = "",
    area_emisora: str = "",
    gestor_emisor: str = "",
    area_salida: str = "",
    area_destino: str = "",
    gestor_salida: str = "",
    asesor_destino: str = "",
    asesor_reporte: str = "",
    reporte_dia: date | None = None,
    reporte_estado: str = "",
    reporte_desde: date | None = None,
    reporte_hasta: date | None = None,
    alerta_solucion: str = "",
    condicion_usuario: str = "",
    condicion_final_usuario: str = "",
    categoria: str = "TODAS",
    estado: str = "",
    buscar: str = "",
    dni: str = "",
    caso_id: str = "",
    detalle: str = "",
    pagina: int = 1,
    seguimiento_pagina: int = 1,
    exportar_excel: bool = False,
    flujo_mensual: bool = False,
):
    if desde and hasta and desde > hasta:
        raise HTTPException(
            status_code=400,
            detail="La fecha inicial no puede ser posterior a la fecha final.",
        )

    cases = obtener_casos()
    date_series = cases["FECHA INGRESO"].dropna()
    if desde is None and hasta is None and not date_series.empty:
        desde = date_series.min().date()
        hasta = date_series.max().date()

    filtered = cases.copy()
    condition_selection = limpiar_columna(pd.Series([condicion_usuario])).iloc[0].upper()
    category_selection = limpiar_columna(pd.Series([categoria])).iloc[0].upper()
    category_aliases = {
        "TODAS": "TODAS",
        "RECIBIDOS NO DERIVADOS": "RECIBIDOS_NO_DERIVADOS",
        "RECIBIDOS_NO_DERIVADOS": "RECIBIDOS_NO_DERIVADOS",
        "RECIBIDOS DERIVADOS": "RECIBIDOS_DERIVADOS",
        "RECIBIDOS_DERIVADOS": "RECIBIDOS_DERIVADOS",
        "SALIENTES": "SALIENTES",
        "SALIENTES A OTRAS ÁREAS": "SALIENTES",
        "SALIENTES A OTRAS AREAS": "SALIENTES",
    }
    category_selection = category_aliases.get(category_selection, category_selection)
    if category_selection not in {
        "TODAS",
        "RECIBIDOS_NO_DERIVADOS",
        "RECIBIDOS_DERIVADOS",
        "SALIENTES",
    }:
        raise HTTPException(status_code=400, detail="La categoría seleccionada no es válida.")
    outgoing_mode = category_selection == "SALIENTES" or detalle.startswith("salientes") or bool(
        area_salida or area_destino or gestor_salida or asesor_destino
    ) or bool(
        area_salida or area_destino or gestor_salida or asesor_destino
    )

    def filter_text(frame: pd.DataFrame, column: str, value: str, empty_labels: set[str]) -> pd.DataFrame:
        values = limpiar_columna(frame[column])
        return frame[values.eq("") if value in empty_labels else values.eq(value)]

    for parameter, column in (
        (gestor, "ASESOR FINAL"),
        (tipo, "TIPO CASO FINAL"),
        (motivo, "MOTIVO FINAL"),
        (submotivo, "SUBMOTIVO FINAL"),
        (empresa, "EMPRESA"),
        (canal, "CANAL"),
        (alerta_solucion, "ALERTA SOLUCIÓN"),
        (condicion_usuario, "CONDICIÓN USUARIO"),
        (condicion_final_usuario, "CONDICIÓN FINAL USUARIO"),
    ):
        if parameter and column in filtered.columns:
            values = limpiar_columna(filtered[column])
            if column == "CONDICIÓN FINAL USUARIO":
                valid_final_condition = limpiar_columna(
                    filtered["CONDICIÓN USUARIO"]
                ).eq("DERIVADO")
                if parameter in {"SIN CONDICIÓN", "CAMPO EN BLANCO"}:
                    filtered = filtered[valid_final_condition & values.eq("")]
                else:
                    filtered = filtered[valid_final_condition & values.eq(parameter)]
            elif parameter in {"SIN CONDICIÓN", "CAMPO EN BLANCO"}:
                filtered = filtered[values.eq("")]
            elif column == "ASESOR FINAL" and parameter == "SIN ASESOR":
                filtered = filtered[values.eq("")]
            else:
                filtered = filtered[values == parameter]

    if condition_selection in {"SIN CONDICIÓN", "CAMPO EN BLANCO"}:
        filtered = filter_text(
            filtered, "CONDICIÓN USUARIO", condition_selection, {"SIN CONDICIÓN", "CAMPO EN BLANCO"}
        )

    followup_source = filtered.copy()
    if desde:
        filtered = filtered[filtered["FECHA INGRESO"] >= pd.Timestamp(desde)]
    if hasta:
        filtered = filtered[filtered["FECHA INGRESO"] < pd.Timestamp(hasta) + pd.Timedelta(days=1)]

    case_ids = limpiar_columna(filtered["ID CASO"])
    incoming_counts = pd.to_numeric(filtered["SUMA TOTAL INGRESADOS"], errors="coerce")
    outgoing_counts = pd.to_numeric(filtered["SUMA CASOS SALIENTES"], errors="coerce")
    valid_ids = case_ids.ne("")
    valid_received = valid_ids & incoming_counts.eq(1)
    derived_by_area = mascara_derivado_por_area(filtered)
    incoming_cases = filtered[valid_received]
    outgoing_cases = filtered[valid_ids & outgoing_counts.eq(1) & derived_by_area]

    def filter_by_attributed_area(
        frame: pd.DataFrame,
        area_column: str,
        selected_area: str,
    ) -> pd.DataFrame:
        return filter_text(frame, area_column, selected_area, {"SIN ÁREA"})

    if outgoing_mode:
        sent = outgoing_cases
        if area:
            sent = filter_by_attributed_area(sent, "ÁREA INICIAL", area)
        received = sent
    elif category_selection == "RECIBIDOS_NO_DERIVADOS":
        received = incoming_cases[~derived_by_area]
        if area:
            received = filter_by_attributed_area(received, "ÁREA INICIAL", area)
        sent = outgoing_cases.iloc[0:0]
    elif category_selection == "RECIBIDOS_DERIVADOS":
        received = incoming_cases[derived_by_area]
        if area:
            received = filter_by_attributed_area(received, "ÁREA DERIVADA", area)
        sent = outgoing_cases.iloc[0:0]
    else:
        received = incoming_cases
        if area:
            nonderived = received[~derived_by_area.loc[received.index]]
            derived_received = received[derived_by_area.loc[received.index]]
            nonderived = filter_by_attributed_area(nonderived, "ÁREA INICIAL", area)
            derived_received = filter_by_attributed_area(derived_received, "ÁREA DERIVADA", area)
            received = pd.concat([nonderived, derived_received]).sort_index()
        sent = outgoing_cases
        if area:
            sent = filter_by_attributed_area(sent, "ÁREA INICIAL", area)

    filtered = received
    outflow_values = pd.to_numeric(filtered["SUMA CASOS SALIENTES"], errors="coerce").fillna(0)
    outflow_mask = outflow_values.gt(0)
    received_mask = ~mascara_derivado_por_area(filtered)
    reception_missing_mask = outflow_mask & filtered["FECHA RECEPCIÓN"].isna()

    entry_date = filtered["FECHA INGRESO"]
    reception_date = filtered["FECHA RECEPCIÓN"]
    close_date = filtered["FECHA CIERRE"]
    inconsistent_reception = outflow_mask & reception_date.notna() & (reception_date < entry_date)
    inconsistent_close = (
        filtered["CONDICIÓN USUARIO"].eq("CERRADO")
        & close_date.notna()
        & (close_date < entry_date)
    )
    date_issue_mask = inconsistent_reception | inconsistent_close
    review_mask = filtered["VALIDACIÓN DE DERIVACIÓN"].fillna("").astype(str).str.startswith("REVISAR")
    close_pending_mask = limpiar_columna(filtered["CONDICIÓN USUARIO"]).eq("PENDIENTE")
    attention_pending_mask = estados_condicion_final(filtered).eq("pendiente")
    filtered_solved = mascara_solucionada(filtered)

    if estado:
        state_masks = {
            "RECIBIDO": received_mask,
            "DERIVADO": outflow_mask,
            "SOLUCIONADO": filtered_solved,
            "NO SOLUCIONADO": mascara_no_solucionada(filtered),
            "VENCIDO": filtered["ALERTA TIEMPO"].eq("VENCIDO > 7 DÍAS"),
            "ALERTA 3-7 DÍAS": filtered["ALERTA TIEMPO"].eq("ALERTA 3-7 DÍAS"),
            "PENDIENTE CIERRE": close_pending_mask,
            "PENDIENTE ATENCIÓN": attention_pending_mask,
            "SIN FECHA RECEPCIÓN": reception_missing_mask,
            "FECHAS INCONSISTENTES": date_issue_mask,
            "REVISAR DERIVACIÓN": review_mask,
        }
        selected_mask = state_masks.get(estado)
        if selected_mask is not None:
            filtered = filtered[selected_mask]
            if outgoing_mode:
                sent = sent.loc[sent.index.intersection(filtered.index)]
            else:
                sent_state_masks = {
                    "RECIBIDO": ~mascara_derivado_por_area(sent),
                    "DERIVADO": mascara_derivado_por_area(sent),
                    "SOLUCIONADO": mascara_solucionada(sent),
                    "NO SOLUCIONADO": mascara_no_solucionada(sent),
                    "VENCIDO": sent["ALERTA TIEMPO"].eq("VENCIDO > 7 DÍAS"),
                    "ALERTA 3-7 DÍAS": sent["ALERTA TIEMPO"].eq("ALERTA 3-7 DÍAS"),
                    "PENDIENTE CIERRE": limpiar_columna(sent["CONDICIÓN USUARIO"]).eq("PENDIENTE"),
                    "PENDIENTE ATENCIÓN": estados_condicion_final(sent).eq("pendiente"),
                    "SIN FECHA RECEPCIÓN": sent["FECHA RECEPCIÓN"].isna(),
                    "FECHAS INCONSISTENTES": (
                        sent["FECHA RECEPCIÓN"].notna()
                        & (sent["FECHA RECEPCIÓN"] < sent["FECHA INGRESO"])
                    ) | (
                        sent["CONDICIÓN USUARIO"].eq("CERRADO")
                        & sent["FECHA CIERRE"].notna()
                        & (sent["FECHA CIERRE"] < sent["FECHA INGRESO"])
                    ),
                    "REVISAR DERIVACIÓN": sent["VALIDACIÓN DE DERIVACIÓN"].fillna("")
                    .astype(str).str.startswith("REVISAR"),
                }
                sent_mask = sent_state_masks.get(estado)
                if sent_mask is not None:
                    sent = sent[sent_mask]

    if buscar.strip():
        searchable_columns = [
            column
            for column in (
                "ID CASO",
                "ÁREA INICIAL",
                "ÁREA FINAL",
                "ÁREA QUE SUMA EL INGRESO",
                "ÁREA DE SALIDA",
                "ASESOR FINAL",
                "TIPO CASO FINAL",
                "MOTIVO FINAL",
                "SUBMOTIVO FINAL",
                "EMPRESA",
            )
            if column in filtered.columns
        ]
        search_match = pd.Series(False, index=filtered.index)
        for column in searchable_columns:
            search_match |= filtered[column].fillna("").astype(str).str.contains(
                buscar.strip(), case=False, regex=False
            )
        filtered = filtered[search_match]
        sent_search_match = pd.Series(False, index=sent.index)
        for column in searchable_columns:
            if column in sent.columns:
                sent_search_match |= sent[column].fillna("").astype(str).str.contains(
                    buscar.strip(), case=False, regex=False
                )
        sent = sent[sent_search_match]

    received = filtered
    if asesor_reporte and detalle in {
        "seguimiento_semanal",
        "seguimiento_mensual",
        "recibidos_derivados",
    }:
        if detalle == "recibidos_derivados":
            report_advisors = limpiar_columna(received["RESPONSABLE DESTINO"]).str.upper()
        else:
            derived_received_mask = mascara_derivado_por_area(received)
            report_advisors = limpiar_columna(received["RESPONSABLE DESTINO"]).where(
                derived_received_mask,
                limpiar_columna(received["GESTOR"]),
            ).str.upper()
        selected_report_advisor = asesor_reporte.strip().upper()
        if selected_report_advisor in {"SIN ASESOR", "SIN RESPONSABLE"}:
            received = received[
                report_advisors.isin({"", "SIN ASESOR", "SIN RESPONSABLE"})
            ]
        else:
            received = received[report_advisors.eq(selected_report_advisor)]

    sending_area = area_salida or (area if outgoing_mode else "")
    if sending_area:
        sent = filter_text(sent, "ÁREA INICIAL", sending_area, {"SIN ÁREA"})
    if area_destino:
        sent = filter_text(sent, "ÁREA DERIVADA", area_destino, {"SIN ÁREA RECEPTORA"})
    if gestor_salida:
        sent = filter_text(sent, "GESTOR", gestor_salida, {"SIN ASESOR"})
    if asesor_destino:
        sent = filter_text(sent, "RESPONSABLE DESTINO", asesor_destino, {"SIN RESPONSABLE"})

    incoming_total = suma_columna(received, "SUMA TOTAL INGRESADOS")
    outflow_total = suma_columna(sent, "SUMA CASOS SALIENTES")
    sent_final_status = estados_condicion_final(sent)
    sent_solved = mascara_solucionada(sent)
    outgoing_solved = suma_columna(sent, "SUMA CASOS SALIENTES", sent_solved)
    outgoing_unsolved = suma_columna(
        sent, "SUMA CASOS SALIENTES", mascara_no_solucionada(sent)
    )
    outgoing_attention_pending = suma_columna(
        sent,
        "SUMA CASOS SALIENTES",
        sent_final_status.eq("pendiente"),
    )
    outgoing_missing_final_condition = suma_columna(
        sent,
        "SUMA CASOS SALIENTES",
        sent_final_status.eq("sin_condicion"),
    )
    outgoing_attended = suma_columna(
        sent,
        "SUMA CASOS SALIENTES",
        sent_final_status.eq("atendido"),
    )
    summary_count_column = "SUMA CASOS SALIENTES" if outgoing_mode else "SUMA TOTAL INGRESADOS"
    active_total = outflow_total if outgoing_mode else incoming_total
    motive_cases = received.copy()
    motive_cases["_tipo_motivo"] = limpiar_columna(motive_cases["TIPO CASO FINAL"])
    motive_cases["_motivo"] = limpiar_columna(motive_cases["MOTIVO FINAL"]).replace(
        "", "SIN MOTIVO"
    )
    motive_cases["_submotivo"] = limpiar_columna(
        motive_cases["SUBMOTIVO FINAL"]
    ).replace("", "SIN SUBMOTIVO")
    motive_cases["_cantidad_motivo"] = pd.to_numeric(
        motive_cases[summary_count_column], errors="coerce"
    ).fillna(0)
    motive_cases["_dias_motivo"] = pd.to_numeric(
        motive_cases["DÍAS TRANSCURRIDOS"], errors="coerce"
    )
    motive_cases["_solucionado_motivo"] = mascara_solucionada(motive_cases)
    motive_cases["_no_solucionado_motivo"] = mascara_no_solucionada(motive_cases)
    motive_breakdown, motive_breakdown_totals = resumir_motivos_sql(motive_cases)

    received_user_condition = limpiar_columna(received["CONDICIÓN USUARIO"])
    received_final_status = estados_condicion_final(received)
    received_derived = mascara_derivado_por_area(received)
    received_nonderived = ~received_derived
    received_case_ids = limpiar_columna(received["ID CASO"]).ne("")
    received_single_entries = pd.to_numeric(
        received[summary_count_column], errors="coerce"
    ).eq(1)
    valid_received_entry = received_case_ids & received_single_entries
    closed_nonderived = valid_received_entry & received_nonderived & received_user_condition.eq("CERRADO")
    pending_nonderived = valid_received_entry & received_nonderived & received_user_condition.eq("PENDIENTE")
    blank_nonderived = valid_received_entry & received_nonderived & received_user_condition.eq("")
    attended_derived = valid_received_entry & received_final_status.eq("atendido")
    pending_derived = valid_received_entry & received_final_status.eq("pendiente")
    blank_derived = valid_received_entry & received_final_status.eq("sin_condicion")
    solved_cases = mascara_solucionada(received)
    unsolved_cases = mascara_no_solucionada(received)
    solved_closing = suma_columna(received, summary_count_column, received_user_condition.eq("CERRADO"))
    solved_attention = suma_columna(
        received, summary_count_column, received_final_status.eq("atendido")
    )
    close_missing_condition = suma_columna(
        received, summary_count_column, received_user_condition.eq("")
    )
    attention_missing_condition = suma_columna(
        received, summary_count_column, received_final_status.eq("sin_condicion")
    )
    close_pending = suma_columna(
        received, summary_count_column, received_user_condition.eq("PENDIENTE")
    )
    attention_pending = suma_columna(
        received, summary_count_column, received_final_status.eq("pendiente")
    )
    solved = solved_closing + solved_attention
    unsolved = (
        close_pending
        + close_missing_condition
        + attention_pending
        + attention_missing_condition
    )
    overdue = int((received["ALERTA TIEMPO"] == "VENCIDO > 7 DÍAS").sum())
    at_risk = int((received["ALERTA TIEMPO"] == "ALERTA 3-7 DÍAS").sum())
    in_time = int((received["ALERTA TIEMPO"] == "EN PLAZO").sum())
    quality_issues = int(review_mask.loc[received.index].sum())
    reception_missing = int(reception_missing_mask.loc[received.index].sum())
    date_issues = int(date_issue_mask.loc[received.index].sum())

    area_received = received
    if area_desde:
        area_received = area_received[
            area_received["FECHA INGRESO"] >= pd.Timestamp(area_desde)
        ]
    if area_hasta:
        area_received = area_received[
            area_received["FECHA INGRESO"] < pd.Timestamp(area_hasta) + pd.Timedelta(days=1)
        ]

    area_ingress = (
        area_received.assign(
            _ingresos=pd.to_numeric(area_received[summary_count_column], errors="coerce").fillna(0),
            _solucionados=pd.to_numeric(
                area_received[summary_count_column], errors="coerce"
            ).fillna(0).where(mascara_solucionada(area_received), 0),
            _no_solucionados=pd.to_numeric(
                area_received[summary_count_column], errors="coerce"
            ).fillna(0).where(mascara_no_solucionada(area_received), 0),
        )
        .assign(_area_atribuida=lambda frame: frame["ÁREA DERIVADA"].where(
            mascara_derivado_por_area(frame), frame["ÁREA INICIAL"]
        ))
        .groupby("_area_atribuida", dropna=False)
        .agg(
            ingresos=("_ingresos", "sum"),
            solucionados=("_solucionados", "sum"),
            no_solucionados=("_no_solucionados", "sum"),
        )
    )
    outgoing_by_area = (
        sent.assign(
            _salientes=pd.to_numeric(sent["SUMA CASOS SALIENTES"], errors="coerce").fillna(0),
            _solucionados=pd.to_numeric(
                sent["SUMA CASOS SALIENTES"], errors="coerce"
            ).fillna(0).where(mascara_solucionada(sent), 0),
            _no_solucionados=pd.to_numeric(
                sent["SUMA CASOS SALIENTES"], errors="coerce"
            ).fillna(0).where(mascara_no_solucionada(sent), 0),
        )
        .groupby("ÁREA INICIAL", dropna=False)
        .agg(
            salientes=("_salientes", "sum"),
            solucionados=("_solucionados", "sum"),
            no_solucionados=("_no_solucionados", "sum"),
        )
    )
    receiving_areas = [
        {
            "nombre": str(name),
            "cantidad": int(row["ingresos"]),
            "solucionados": int(row["solucionados"]),
            "no_solucionados": int(row["no_solucionados"]),
        }
        for name, row in area_ingress.sort_values("ingresos", ascending=False).iterrows()
        if pd.notna(name)
    ]
    derived_received = received[received_derived].assign(
        _ingresos=lambda df: pd.to_numeric(
            df[summary_count_column], errors="coerce"
        ).fillna(0),
        _solucionados=lambda df: pd.to_numeric(
            df[summary_count_column], errors="coerce"
        ).fillna(0).where(mascara_solucionada(df), 0),
        _no_solucionados=lambda df: pd.to_numeric(
            df[summary_count_column], errors="coerce"
        ).fillna(0).where(mascara_no_solucionada(df), 0),
    )
    derived_received_by_area = (
        derived_received.groupby("ÁREA DERIVADA", dropna=False)
        .agg(
            recibidos=("_ingresos", "sum"),
            solucionados=("_solucionados", "sum"),
            no_solucionados=("_no_solucionados", "sum"),
        )
        .sort_values("recibidos", ascending=False)
    )
    receiving_derived_areas = [
        {
            "nombre": str(name),
            "recibidos": int(row["recibidos"]),
            "solucionados": int(row["solucionados"]),
            "no_solucionados": int(row["no_solucionados"]),
        }
        for name, row in derived_received_by_area.iterrows()
        if pd.notna(name)
    ]
    sending_areas = [
        {
            "nombre": str(name),
            "cantidad": int(row["salientes"]),
            "salientes": int(row["salientes"]),
            "solucionados": int(row["solucionados"]),
            "no_solucionados": int(row["no_solucionados"]),
        }
        for name, row in outgoing_by_area.sort_values("salientes", ascending=False).iterrows()
        if pd.notna(name)
    ]
    area_flows = resumir_flujos(
        sent,
        "ÁREA INICIAL",
        "ÁREA DERIVADA",
        "SUMA CASOS SALIENTES",
    )

    today = date.today()
    if flujo_mensual:
        if desde is None or hasta is None:
            raise HTTPException(
                status_code=400,
                detail="El flujo mensual requiere fechas inicial y final.",
            )
        report_start, report_end = desde, hasta
    elif desde and hasta and (hasta - desde).days < 7:
        report_start, report_end = desde, hasta
    elif desde:
        if hasta:
            report_anchor = min(hasta, today)
            report_start = report_anchor - timedelta(days=report_anchor.weekday())
            report_end = report_start + timedelta(days=6)
        else:
            report_start, report_end = desde, desde + timedelta(days=6)
    elif hasta:
        report_start, report_end = hasta - timedelta(days=6), hasta
    else:
        report_start = today - timedelta(days=today.weekday())
        report_end = report_start + timedelta(days=6)
    week_days = [
        report_start + timedelta(days=offset)
        for offset in range((report_end - report_start).days + 1)
    ]
    weekly_report_cases = received.assign(
        _area=received["ÁREA DERIVADA"].where(
            mascara_derivado_por_area(received), received["ÁREA INICIAL"]
        ).fillna("").astype(str).str.strip(),
        _asesor=received["RESPONSABLE DESTINO"].where(
            mascara_derivado_por_area(received), received["GESTOR"]
        ).fillna("").astype(str).str.strip(),
        _cantidad=pd.to_numeric(
            received[summary_count_column], errors="coerce"
        ).fillna(0),
    )
    weekly_solved_mask = mascara_solucionada(weekly_report_cases)
    weekly_window_cases = weekly_report_cases.dropna(subset=["FECHA INGRESO"]).copy()
    weekly_window_cases = weekly_window_cases[
        fechas_como_date(weekly_window_cases["FECHA INGRESO"]).between(
            week_days[0], week_days[-1]
        )
    ].assign(
        _dia=lambda frame: fechas_como_date(frame["FECHA INGRESO"]),
    )
    solved_cases = weekly_window_cases[weekly_solved_mask.loc[weekly_window_cases.index]].assign(
        _solucionados=lambda frame: frame["_cantidad"]
    )
    unsolved_cases = weekly_window_cases[
        mascara_no_solucionada(weekly_window_cases)
    ].assign(_no_solucionados=lambda frame: frame["_cantidad"])

    advisor_days: dict[tuple[str, str], dict[date, dict[str, int]]] = {}
    for cases_by_result, result_column in (
        (solved_cases, "_solucionados"),
        (unsolved_cases, "_no_solucionados"),
    ):
        grouped_results = cases_by_result.groupby(
            ["_area", "_asesor", "_dia"], dropna=False
        )[result_column].sum()
        for (area_name, advisor_name, day), value in grouped_results.items():
            days = advisor_days.setdefault(
                (area_name, advisor_name),
                {
                    current_day: {"solucionados": 0, "no_solucionados": 0}
                    for current_day in week_days
                },
            )
            days[day][
                "solucionados" if result_column == "_solucionados" else "no_solucionados"
            ] = int(value)

    advisor_week_data = [
        {
            "area": area_name or "SIN ÁREA",
            "asesor": advisor_name or "SIN ASESOR",
            "dias": [
                {"fecha": day.isoformat(), **days[day]}
                for day in week_days
            ],
        }
        for (area_name, advisor_name), days in advisor_days.items()
    ]
    advisor_week_data.sort(key=lambda item: (item["area"], item["asesor"]))

    advisor_period_cases = received.copy().assign(
        _area=lambda frame: frame["ÁREA DERIVADA"].where(
            mascara_derivado_por_area(frame), frame["ÁREA INICIAL"]
        ).fillna("").astype(str).str.strip(),
        _asesor=lambda frame: frame["RESPONSABLE DESTINO"].where(
            mascara_derivado_por_area(frame), frame["GESTOR"]
        ).fillna("").astype(str).str.strip(),
        _cantidad=lambda frame: pd.to_numeric(
            frame[summary_count_column], errors="coerce"
        ).fillna(0),
    )
    advisor_period_cases["_solucionados"] = advisor_period_cases["_cantidad"].where(
        mascara_solucionada(advisor_period_cases), 0
    )
    advisor_period_cases["_no_solucionados"] = advisor_period_cases["_cantidad"].where(
        mascara_no_solucionada(advisor_period_cases), 0
    )
    advisor_period_cases["_en_plazo"] = advisor_period_cases["_cantidad"].where(
        limpiar_columna(advisor_period_cases["ALERTA TIEMPO"]).eq("EN PLAZO"), 0
    )

    def resumir_casos_asesor(
        advisor_cases: pd.DataFrame,
        include_month_weeks: bool = False,
        month_week_count: int = 5,
        month_week_offset: int = 0,
    ) -> list[dict[str, object]]:
        advisor_data = []
        for (area_name, advisor_name), group in advisor_cases.groupby(
            ["_area", "_asesor"], dropna=False, sort=False
        ):
            record = {
                "area": area_name or "SIN ÁREA",
                "asesor": advisor_name or "SIN ASESOR",
                "en_plazo": int(group["_en_plazo"].sum()),
                "solucionados": int(group["_solucionados"].sum()),
                "no_solucionados": int(group["_no_solucionados"].sum()),
                "total": int(group["_cantidad"].sum()),
            }
            if include_month_weeks:
                dated_group = group.dropna(subset=["FECHA INGRESO"]).copy()
                dated_group["_semana_mes"] = (
                    (dated_group["FECHA INGRESO"].dt.day + month_week_offset - 1) // 7 + 1
                )
                weekly_totals = dated_group.groupby("_semana_mes").agg(
                    solucionados=("_solucionados", "sum"),
                    no_solucionados=("_no_solucionados", "sum"),
                )
                record["semanas"] = [
                    {
                        "semana": week_number,
                        "solucionados": int(weekly_totals.loc[week_number, "solucionados"])
                        if week_number in weekly_totals.index else 0,
                        "no_solucionados": int(weekly_totals.loc[week_number, "no_solucionados"])
                        if week_number in weekly_totals.index else 0,
                    }
                    for week_number in range(1, month_week_count + 1)
                ]
            advisor_data.append(record)
        advisor_data.sort(key=lambda item: (item["area"], item["asesor"]))
        return advisor_data

    advisor_period_data = resumir_casos_asesor(advisor_period_cases)
    advisor_month_anchor = hasta or (
        cases["FECHA INGRESO"].dropna().max().date()
        if not cases["FECHA INGRESO"].dropna().empty
        else today
    )
    advisor_month_start = date(advisor_month_anchor.year, advisor_month_anchor.month, 1)
    advisor_month_end = date(
        advisor_month_anchor.year + (advisor_month_anchor.month == 12),
        advisor_month_anchor.month % 12 + 1,
        1,
    )
    advisor_month_cases = advisor_period_cases[
        (advisor_period_cases["FECHA INGRESO"] >= pd.Timestamp(advisor_month_start))
        & (advisor_period_cases["FECHA INGRESO"] < pd.Timestamp(advisor_month_end))
    ]
    advisor_month_data = resumir_casos_asesor(
        advisor_month_cases,
        include_month_weeks=True,
        month_week_count=(
            (advisor_month_start.weekday() + (advisor_month_end - advisor_month_start).days + 6)
            // 7
        ),
        month_week_offset=advisor_month_start.weekday(),
    )
    advisor_period_dates = advisor_period_cases["FECHA INGRESO"].dropna()
    advisor_period_start = desde.isoformat() if desde else (
        advisor_period_dates.min().date().isoformat()
        if not advisor_period_dates.empty else None
    )
    advisor_period_end = hasta.isoformat() if hasta else (
        advisor_period_dates.max().date().isoformat()
        if not advisor_period_dates.empty else None
    )

    area_summary_cases = received.copy().assign(
        _area=lambda frame: frame["ÁREA DERIVADA"].where(
            mascara_derivado_por_area(frame), frame["ÁREA INICIAL"]
        ).fillna("").astype(str).str.strip().replace("", "SIN ÁREA"),
        _cantidad=lambda frame: pd.to_numeric(
            frame[summary_count_column], errors="coerce"
        ).fillna(0),
    )
    area_summary_cases["_solucionado_eficiencia"] = mascara_solucionada(area_summary_cases)
    area_summary_cases["_no_solucionado_eficiencia"] = mascara_no_solucionada(area_summary_cases)
    area_summary_cases["_en_plazo_eficiencia"] = limpiar_columna(
        area_summary_cases["ALERTA TIEMPO"]
    ).eq("EN PLAZO")

    def promedio_ponderado(
        frame: pd.DataFrame,
        day_column: str,
        count_column: str,
        mask: pd.Series | None = None,
    ) -> float | None:
        days = pd.to_numeric(frame[day_column], errors="coerce")
        counts = pd.to_numeric(frame[count_column], errors="coerce").fillna(0)
        if mask is not None:
            days = days[mask]
            counts = counts[mask]
        valid = days.notna() & counts.gt(0)
        denominator = counts[valid].sum()
        if denominator <= 0:
            return None
        return float((days[valid] * counts[valid]).sum() / denominator)

    def resumir_eficiencia_area(
        area_name: str,
        area_cases: pd.DataFrame,
        total_managed: int,
    ) -> dict[str, object]:
        total_cases = int(area_cases["_cantidad"].sum())
        solved_mask = area_cases["_solucionado_eficiencia"]
        unsolved_mask = area_cases["_no_solucionado_eficiencia"]
        in_time_mask = area_cases["_en_plazo_eficiencia"]
        solved = int(area_cases["_cantidad"].where(solved_mask, 0).sum())
        unsolved = int(area_cases["_cantidad"].where(unsolved_mask, 0).sum())
        in_time = int(area_cases["_cantidad"].where(in_time_mask, 0).sum())
        efficiency = (
            (solved + in_time) * 100 / (total_cases * 2)
            if total_cases else None
        )
        return {
            "area": area_name,
            "total_gestionados": total_cases,
            "porcentaje_total_gestionados": (
                total_cases * 100 / total_managed if total_managed else None
            ),
            "promedio_dias": promedio_ponderado(
                area_cases, "DÍAS TRANSCURRIDOS", "_cantidad"
            ),
            "porcentaje_tiempo": in_time * 100 / total_cases if total_cases else None,
            "solucionados": solved,
            "porcentaje_solucionados": solved * 100 / total_cases if total_cases else None,
            "promedio_dias_solucionados": promedio_ponderado(
                area_cases, "DÍAS TRANSCURRIDOS", "_cantidad", solved_mask
            ),
            "no_solucionados": unsolved,
            "porcentaje_no_solucionados": (
                unsolved * 100 / total_cases if total_cases else None
            ),
            "promedio_dias_no_solucionados": promedio_ponderado(
                area_cases, "DÍAS TRANSCURRIDOS", "_cantidad", unsolved_mask
            ),
            "eficiencia_general": efficiency,
            "estado": clasificar_estado_eficiencia(total_cases, efficiency),
        }

    area_total_managed = int(area_summary_cases["_cantidad"].sum())
    area_names = sorted(set(area_summary_cases["_area"]))
    area_efficiency_rows = [
        resumir_eficiencia_area(
            area_name,
            area_summary_cases[area_summary_cases["_area"].eq(area_name)],
            area_total_managed,
        )
        for area_name in area_names
    ]
    area_efficiency_total = resumir_eficiencia_area(
        "TOTAL DEL PERÍODO",
        area_summary_cases,
        area_total_managed,
    )
    def resumir_categorias_por_tipo(
        column: str,
        missing_label: str,
    ) -> dict[str, object]:
        comparison_cases = received.copy()
        comparison_cases["_tipo_comparativo"] = limpiar_columna(
            comparison_cases["TIPO CASO FINAL"]
        )
        comparison_cases["_categoria_comparativo"] = (
            comparison_cases[column].fillna("").astype(str).str.strip()
        )
        comparison_cases["_cantidad_comparativo"] = pd.to_numeric(
            comparison_cases[summary_count_column], errors="coerce"
        ).fillna(0)
        available_categories = cases[column].fillna("").astype(str).str.strip()
        category_names = list(dict.fromkeys(
            available_categories[available_categories.ne("")].tolist()
        ))
        result: dict[str, object] = {}
        grand_total = 0
        for case_type in ("CONSULTA", "RECLAMO"):
            type_cases = comparison_cases[
                comparison_cases["_tipo_comparativo"].eq(case_type)
            ]
            category_rows = []
            total_for_type = int(type_cases["_cantidad_comparativo"].sum())
            grand_total += total_for_type
            names = [(name, False) for name in category_names]
            missing_cases = type_cases[
                type_cases["_categoria_comparativo"].eq("")
                & type_cases["_cantidad_comparativo"].gt(0)
            ]
            if not missing_cases.empty:
                names.append((missing_label, True))
            for category_name, is_missing in names:
                selected_cases = (
                    missing_cases
                    if is_missing
                    else type_cases[
                        type_cases["_categoria_comparativo"].eq(category_name)
                    ]
                )
                category_rows.append({
                    "nombre": category_name,
                    "total": int(selected_cases["_cantidad_comparativo"].sum()),
                })
            result[case_type] = {
                "registros": category_rows,
                "total": total_for_type,
            }
        result["total"] = grand_total
        return result

    company_comparison = resumir_categorias_por_tipo("EMPRESA", "SIN EMPRESA")
    channel_comparison = resumir_categorias_por_tipo("CANAL", "SIN CANAL")
    advisor_efficiency_cases = advisor_period_cases.copy()
    advisor_efficiency_cases["_area"] = advisor_efficiency_cases["_area"].replace("", "SIN ÁREA")
    advisor_efficiency_cases["_asesor"] = advisor_efficiency_cases["_asesor"].replace(
        "", "SIN ASESOR"
    )
    advisor_efficiency_cases["_solucionado_eficiencia"] = mascara_solucionada(
        advisor_efficiency_cases
    )
    advisor_efficiency_cases["_no_solucionado_eficiencia"] = mascara_no_solucionada(
        advisor_efficiency_cases
    )
    advisor_efficiency_cases["_en_plazo_eficiencia"] = limpiar_columna(
        advisor_efficiency_cases["ALERTA TIEMPO"]
    ).eq("EN PLAZO")
    advisor_efficiency_rows = []
    for (area_name, advisor_name), advisor_cases in advisor_efficiency_cases.groupby(
        ["_area", "_asesor"], dropna=False, sort=False
    ):
        advisor_efficiency_rows.append({
            **resumir_eficiencia_area(
                advisor_name,
                advisor_cases,
                area_total_managed,
            ),
            "area": area_name,
            "asesor": advisor_name,
        })
    advisor_efficiency_rows.sort(key=lambda item: (item["area"], item["asesor"]))

    advisor_trend_cases = received.dropna(subset=["FECHA INGRESO"]).copy()
    advisor_trend_cases = advisor_trend_cases.assign(
        _area=lambda frame: frame["ÁREA DERIVADA"].where(
            mascara_derivado_por_area(frame), frame["ÁREA INICIAL"]
        ).fillna("").astype(str).str.strip(),
        _asesor=lambda frame: frame["RESPONSABLE DESTINO"].where(
            mascara_derivado_por_area(frame), frame["GESTOR"]
        ).fillna("").astype(str).str.strip(),
        _mes=lambda frame: frame["FECHA INGRESO"].dt.strftime("%Y-%m"),
        _cantidad=lambda frame: pd.to_numeric(
            frame[summary_count_column], errors="coerce"
        ).fillna(0),
    )
    advisor_trend_cases["_solucionados"] = advisor_trend_cases["_cantidad"].where(
        mascara_solucionada(advisor_trend_cases), 0
    )
    advisor_trend_cases["_no_solucionados"] = advisor_trend_cases["_cantidad"].where(
        mascara_no_solucionada(advisor_trend_cases), 0
    )
    advisor_trend_groups = advisor_trend_cases.groupby(
        ["_area", "_asesor", "_mes"], dropna=False, sort=True
    )[["_solucionados", "_no_solucionados", "_cantidad"]].sum()
    advisor_trend_data = [
        {
            "area": area_name or "SIN ÁREA",
            "asesor": advisor_name or "SIN ASESOR",
            "mes": month,
            "solucionados": int(row["_solucionados"]),
            "no_solucionados": int(row["_no_solucionados"]),
            "total": int(row["_cantidad"]),
        }
        for (area_name, advisor_name, month), row in advisor_trend_groups.iterrows()
    ]

    def resumir_semana_por_asesor(
        source: pd.DataFrame,
        area_column: str,
        daily_count_column: str,
        status_columns: tuple[tuple[str, tuple[str, str]], ...],
        advisor_column: str = "ASESOR FINAL",
    ) -> list[dict[str, object]]:
        report_cases = source.dropna(subset=["FECHA INGRESO"]).copy()
        report_cases = report_cases[
            fechas_como_date(report_cases["FECHA INGRESO"]).between(week_days[0], week_days[-1])
        ].assign(
            _area=source[area_column].fillna("").astype(str).str.strip(),
            _asesor=source[advisor_column].fillna("").astype(str).str.strip(),
            _dia=fechas_como_date(source["FECHA INGRESO"]),
            _cantidad=pd.to_numeric(source[daily_count_column], errors="coerce").fillna(0),
        )
        for result_name, status_column in status_columns:
            status_values = source[status_column[0]]
            status_matches = (
                limpiar_columna(status_values).eq("")
                if status_column[1] == ""
                else limpiar_columna(status_values).eq(status_column[1])
            )
            report_cases[f"_{result_name}"] = report_cases["_cantidad"].where(
                status_matches, 0
            )

        grouped = report_cases.groupby(["_area", "_asesor"], dropna=False, sort=False)
        report = []
        for (area_name, advisor_name), advisor_cases in grouped:
            daily_totals = advisor_cases.groupby("_dia")["_cantidad"].sum()
            status_totals = {
                result_name: int(advisor_cases[f"_{result_name}"].sum())
                for result_name, _ in status_columns
            }
            report.append({
                "area": area_name or "SIN ÁREA",
                "asesor": advisor_name or "SIN ASESOR",
                "dias": [
                    {
                        "fecha": day.isoformat(),
                        "total": int(daily_totals.get(day, 0)),
                    }
                    for day in week_days
                ],
                "semanal": status_totals,
            })
        return sorted(report, key=lambda item: (item["area"], item["asesor"]))

    def resumir_recibidos_por_semana(
        source: pd.DataFrame,
        area_column: str,
        unsolved_status_column: str,
    ) -> list[dict[str, object]]:
        report_cases = source.dropna(subset=["FECHA INGRESO"]).copy()
        report_cases["_dia"] = fechas_como_date(report_cases["FECHA INGRESO"])
        report_cases = report_cases[
            report_cases["_dia"].between(week_days[0], week_days[-1])
        ].assign(
            _area=lambda frame: frame[area_column].fillna("").astype(str).str.strip(),
            _asesor=lambda frame: frame["ASESOR FINAL"].fillna("").astype(str).str.strip(),
            _cantidad=lambda frame: pd.to_numeric(
                frame["SUMA TOTAL INGRESADOS"], errors="coerce"
            ).fillna(0),
        )
        status_values = limpiar_columna(report_cases[unsolved_status_column])
        if unsolved_status_column == "CONDICIÓN USUARIO":
            report_cases["_estado"] = status_values.map({
                "CERRADO": "cerrado",
                "PENDIENTE": "pendiente",
                "": "sin_condicion",
            })
            statuses = ("cerrado", "pendiente", "sin_condicion")
        else:
            report_cases["_estado"] = status_values.map({
                "ATENDIDO": "atendido",
                "PENDIENTE": "pendiente",
                "": "sin_condicion",
            })
            statuses = ("atendido", "pendiente", "sin_condicion")
        grouped = report_cases.groupby(["_area", "_asesor"], dropna=False, sort=False)
        report = []
        for (area_name, advisor_name), advisor_cases in grouped:
            daily_totals = advisor_cases.groupby("_dia")["_cantidad"].sum()
            status_totals = {
                status: int(advisor_cases.loc[
                    advisor_cases["_estado"].eq(status), "_cantidad"
                ].sum())
                for status in statuses
            }
            report.append({
                "area": area_name or "SIN ÁREA",
                "asesor": advisor_name or "SIN ASESOR",
                "dias": [
                    {"fecha": day.isoformat(), "total": int(daily_totals.get(day, 0))}
                    for day in week_days
                ],
                "semanal": status_totals,
            })
        return sorted(report, key=lambda item: (item["area"], item["asesor"]))

    advisor_nonderived_week = resumir_recibidos_por_semana(
        received[~mascara_derivado_por_area(received)],
        "ÁREA INICIAL",
        "CONDICIÓN USUARIO",
    )
    derived_received = received[mascara_derivado_por_area(received)]
    derived_received_week_cases = derived_received.dropna(subset=["FECHA INGRESO"]).copy()
    derived_received_week_cases["_dia"] = fechas_como_date(
        derived_received_week_cases["FECHA INGRESO"]
    )
    derived_received_week_cases["_estado_final"] = estados_condicion_final(
        derived_received_week_cases
    )
    derived_received_week_cases = derived_received_week_cases[
        derived_received_week_cases["_dia"].between(week_days[0], week_days[-1])
    ].assign(
        _area=lambda frame: frame["ÁREA DERIVADA"].fillna("").astype(str).str.strip(),
        _asesor=lambda frame: frame["RESPONSABLE DESTINO"].fillna("").astype(str).str.strip(),
        _area_emisora=lambda frame: frame["ÁREA INICIAL"].fillna("").astype(str).str.strip(),
        _asesor_emisor=lambda frame: frame["GESTOR"].fillna("").astype(str).str.strip(),
        _cantidad=lambda frame: pd.to_numeric(
            frame["SUMA TOTAL INGRESADOS"], errors="coerce"
        ).fillna(0),
    )
    advisor_derived_received_week = []
    derived_received_groups = derived_received_week_cases.groupby(
        ["_area", "_asesor"], dropna=False, sort=False
    )
    for (area_name, advisor_name), advisor_cases in derived_received_groups:
        daily_totals = advisor_cases.groupby("_dia")["_cantidad"].sum()
        emitter_groups = advisor_cases.groupby(
            ["_area_emisora", "_asesor_emisor"], dropna=False, sort=False
        )
        transfers = []
        for (emitter_area, emitter_name), transfer_cases in emitter_groups:
            quantity = transfer_cases["_cantidad"]
            statuses = transfer_cases["_estado_final"]
            transfers.append({
                "area_emisora": emitter_area or "SIN ÁREA EMISORA",
                "total": int(quantity.sum()),
                "asesor_emisor": emitter_name or "SIN RESPONSABLE",
                "atendido": int(quantity.where(statuses.eq("atendido"), 0).sum()),
                "pendiente": int(quantity.where(statuses.eq("pendiente"), 0).sum()),
                "sin_condicion": int(quantity.where(statuses.eq("sin_condicion"), 0).sum()),
            })
        advisor_derived_received_week.append({
            "area": area_name or "SIN ÁREA",
            "asesor": advisor_name or "SIN ASESOR",
            "dias": [
                {"fecha": day.isoformat(), "total": int(daily_totals.get(day, 0))}
                for day in week_days
            ],
            "derivaciones": sorted(
                transfers,
                key=lambda item: (item["area_emisora"], item["asesor_emisor"]),
            ),
        })
    advisor_derived_received_week.sort(
        key=lambda item: (item["area"], item["asesor"])
    )
    outgoing_advisor_destinations = sent.dropna(subset=["FECHA INGRESO"]).copy()
    outgoing_advisor_destinations["_dia"] = fechas_como_date(
        outgoing_advisor_destinations["FECHA INGRESO"]
    )
    outgoing_advisor_destinations["_estado"] = estados_condicion_final(
        outgoing_advisor_destinations
    )
    outgoing_advisor_destinations = outgoing_advisor_destinations[
        outgoing_advisor_destinations["_dia"].between(week_days[0], week_days[-1])
    ].assign(
        _area=lambda frame: frame["ÁREA INICIAL"].fillna("").astype(str).str.strip(),
        _asesor=lambda frame: frame["GESTOR"].fillna("").astype(str).str.strip(),
        _area_receptora=lambda frame: frame["ÁREA DERIVADA"].fillna("").astype(str).str.strip(),
        _receptor=lambda frame: frame["RESPONSABLE DESTINO"].fillna("").astype(str).str.strip(),
        _cantidad=lambda frame: pd.to_numeric(
            frame["SUMA CASOS SALIENTES"], errors="coerce"
        ).fillna(0),
        _estado_final=lambda frame: estados_condicion_final(frame),
    )
    outgoing_statuses = ("atendido", "pendiente", "sin_condicion")
    outgoing_groups = outgoing_advisor_destinations.groupby(
        ["_area", "_asesor"], dropna=False, sort=False
    )
    advisor_outgoing_week = []
    for (area_name, advisor_name), advisor_cases in outgoing_groups:
        daily_totals = advisor_cases.groupby("_dia")["_cantidad"].sum()
        advisor_outgoing_week.append({
            "area": area_name or "SIN ÁREA",
            "asesor": advisor_name or "SIN ASESOR",
            "dias": [
                {"fecha": day.isoformat(), "total": int(daily_totals.get(day, 0))}
                for day in week_days
            ],
            "semanal": {
                status: int(advisor_cases.loc[
                    advisor_cases["_estado"].eq(status), "_cantidad"
                ].sum())
                for status in outgoing_statuses
            },
        })
    advisor_outgoing_week.sort(key=lambda item: (item["area"], item["asesor"]))
    outgoing_destinations_solved = mascara_solucionada(outgoing_advisor_destinations)
    outgoing_advisor_destinations["_solucionados"] = (
        outgoing_advisor_destinations["_cantidad"].where(outgoing_destinations_solved, 0)
    )
    outgoing_advisor_destinations["_no_solucionados"] = (
        outgoing_advisor_destinations["_cantidad"].where(~outgoing_destinations_solved, 0)
    )
    outgoing_advisor_destinations["_atendido"] = (
        outgoing_advisor_destinations["_cantidad"].where(
            outgoing_advisor_destinations["_estado_final"].eq("atendido"), 0
        )
    )
    outgoing_advisor_destinations["_pendiente"] = (
        outgoing_advisor_destinations["_cantidad"].where(
            outgoing_advisor_destinations["_estado_final"].eq("pendiente"), 0
        )
    )
    outgoing_advisor_destinations["_sin_condicion"] = (
        outgoing_advisor_destinations["_cantidad"].where(
            outgoing_advisor_destinations["_estado_final"].eq("sin_condicion"), 0
        )
    )
    destination_groups = outgoing_advisor_destinations.groupby(
        ["_area", "_asesor", "_area_receptora", "_receptor"],
        dropna=False,
        sort=False,
    )[["_cantidad", "_atendido", "_pendiente", "_sin_condicion"]].sum()
    advisor_destination_details: dict[tuple[str, str], list[dict[str, object]]] = {}
    for (area_name, advisor_name, receiver_area, receiver_name), counts in destination_groups.iterrows():
        key = (area_name or "SIN ÁREA", advisor_name or "SIN ASESOR")
        advisor_destination_details.setdefault(key, []).append({
            "area_receptora": receiver_area or "SIN ÁREA RECEPTORA",
            "total": int(counts["_cantidad"]),
            "receptor": receiver_name or "SIN RESPONSABLE",
            "atendido": int(counts["_atendido"]),
            "pendiente": int(counts["_pendiente"]),
            "sin_condicion": int(counts["_sin_condicion"]),
        })
    for advisor_record in advisor_outgoing_week:
        key = (advisor_record["area"], advisor_record["asesor"])
        advisor_record["derivaciones"] = sorted(
            advisor_destination_details.get(key, []),
            key=lambda item: (item["area_receptora"], item["receptor"]),
        )

    yearly = []
    monthly = []
    weekly = []
    daily = []
    if "FECHA INGRESO" in received.columns:
        incoming_by_date = pd.to_numeric(
            received[summary_count_column], errors="coerce"
        ).fillna(0)
        solved_by_date = incoming_by_date.where(mascara_solucionada(received), 0)
        unsolved_by_date = incoming_by_date.where(mascara_no_solucionada(received), 0)
        incoming_by_period = (
            received.assign(
                _mes=received["FECHA INGRESO"].dt.to_period("M"),
                _semana=received["FECHA INGRESO"].dt.to_period("W-SUN").dt.start_time,
                _dia=received["FECHA INGRESO"].dt.normalize(),
                _ingresos=incoming_by_date,
                _solucionados=solved_by_date,
                _no_solucionados=unsolved_by_date,
                _consultas=incoming_by_date.where(
                    received["TIPO CASO FINAL"].eq("CONSULTA"), 0
                ),
                _reclamos=incoming_by_date.where(
                    received["TIPO CASO FINAL"].eq("RECLAMO"), 0
                ),
            )
            .dropna(subset=["_mes"])
        )
        metric_columns = {
            "cantidad": ("_ingresos", "sum"),
            "solucionados": ("_solucionados", "sum"),
            "no_solucionados": ("_no_solucionados", "sum"),
            "consultas": ("_consultas", "sum"),
            "reclamos": ("_reclamos", "sum"),
        }
        monthly_groups = (
            incoming_by_period
            .groupby("_mes")
            .agg(**metric_columns)
        )
        weekly_groups = (
            incoming_by_period.dropna(subset=["_semana"])
            .groupby(["_mes", "_semana"])
            .agg(**metric_columns)
        )
        daily_groups = (
            incoming_by_period.dropna(subset=["_dia"])
            .groupby("_dia")
            .agg(**metric_columns)
        )
        yearly = [
            {
                "anio": int(year),
                **{
                    key: int(value)
                    for key, value in row.items()
                },
            }
            for year, row in monthly_groups.groupby(monthly_groups.index.year).sum().iterrows()
        ]
        monthly = [
            {
                "mes": period.strftime("%Y-%m"),
                **{key: int(value) for key, value in row.items()},
            }
            for period, row in monthly_groups.iterrows()
        ]
        weekly = [
            {
                "mes": period.strftime("%Y-%m"),
                "semana_inicio": week_start.strftime("%Y-%m-%d"),
                **{key: int(value) for key, value in row.items()},
            }
            for (period, week_start), row in weekly_groups.iterrows()
        ]
        daily = [
            {
                "fecha": day.strftime("%Y-%m-%d"),
                **{key: int(value) for key, value in row.items()},
            }
            for day, row in daily_groups.iterrows()
        ]

    type_cases = received.assign(
        _ingresados=pd.to_numeric(
            received[summary_count_column], errors="coerce"
        ).fillna(0),
    )
    type_cases["_solucionados"] = type_cases["_ingresados"].where(
        mascara_solucionada(type_cases), 0
    )
    type_cases["_no_solucionados"] = type_cases["_ingresados"].where(
        mascara_no_solucionada(type_cases), 0
    )
    type_groups = (
        type_cases.groupby("TIPO CASO FINAL", dropna=False)
        .agg(
            ingresados=("_ingresados", "sum"),
            solucionados=("_solucionados", "sum"),
            no_solucionados=("_no_solucionados", "sum"),
        )
        .sort_values("ingresados", ascending=False)
    )
    by_type = [
        {
            "nombre": texto_limpio(name) or "Sin clasificar",
            "ingresados": int(row["ingresados"]),
            "solucionados": int(row["solucionados"]),
            "no_solucionados": int(row["no_solucionados"]),
        }
        for name, row in type_groups.iterrows()
    ]

    quality_categories = [
        {
            "nombre": "Casos con ALERTA CAMPOS VACÍOS",
            "cantidad": int(
                limpiar_columna(received["ALERTA CAMPOS VACÍOS"])
                .ne("COMPLETO")
                .sum()
            ),
            "detail": "calidad_campos_vacios",
        },
        {"nombre": "Derivaciones con origen y destino iguales", "cantidad": quality_issues, "detail": "calidad_revision_derivacion"},
        {"nombre": "Derivaciones sin fecha de recepción", "cantidad": reception_missing, "detail": "calidad_sin_recepcion"},
        {
            "nombre": "Casos cerrados sin fecha de cierre",
            "cantidad": int(
                (
                    received["CONDICIÓN USUARIO"].eq("CERRADO")
                    & received["FECHA CIERRE"].isna()
                ).sum()
            ),
            "detail": "calidad_cerrado_sin_fecha",
        },
        {"nombre": "Fechas previas al ingreso", "cantidad": date_issues, "detail": "calidad_fechas_inconsistentes"},
    ]

    detail_masks = {
        "total": received.index == received.index,
        "seguimiento_semanal": received.index == received.index,
        "seguimiento_mensual": received.index == received.index,
        "solucionados": mascara_solucionada(received),
        "no_solucionados": mascara_no_solucionada(received),
        "consultas": received["TIPO CASO FINAL"].eq("CONSULTA"),
        "reclamos": received["TIPO CASO FINAL"].eq("RECLAMO"),
        "recibidos_no_derivados": valid_received_entry & received_nonderived,
        "recibidos_cerrados": closed_nonderived,
        "recibidos_pendiente_cierre": valid_received_entry & received_user_condition.eq("PENDIENTE"),
        "recibidos_sin_condicion": valid_received_entry & received_user_condition.eq(""),
        "recibidos_derivados": valid_received_entry & received_derived,
        "recibidos_atendidos": attended_derived,
        "recibidos_pendiente_atencion": pending_derived,
        "recibidos_sin_condicion_final": blank_derived,
        "salientes": sent.index == sent.index,
        "salientes_atendidos": estados_condicion_final(sent).eq("atendido"),
        "salientes_pendiente_atencion": estados_condicion_final(sent).eq("pendiente"),
        "salientes_sin_condicion_final": estados_condicion_final(sent).eq("sin_condicion"),
        "calidad_revision_derivacion": review_mask,
        "calidad_sin_recepcion": reception_missing_mask,
        "calidad_campos_vacios": limpiar_columna(
            received["ALERTA CAMPOS VACÍOS"]
        ).ne("COMPLETO"),
        "calidad_cerrado_sin_fecha": (
            received["CONDICIÓN USUARIO"].eq("CERRADO") & received["FECHA CIERRE"].isna()
        ),
        "calidad_fechas_inconsistentes": date_issue_mask,
    }
    detail_titles = {
        "total": "Todos los casos ingresados",
        "seguimiento_semanal": "Seguimiento semanal por asesor y área",
        "seguimiento_mensual": "Acumulado mensual por asesor y área",
        "solucionados": "Casos solucionados",
        "no_solucionados": "Casos no solucionados",
        "consultas": "Consultas",
        "reclamos": "Reclamos",
        "recibidos_no_derivados": "Casos recibidos no derivados",
        "recibidos_cerrados": "Casos cerrados no derivados",
        "recibidos_pendiente_cierre": "Casos pendientes de cierre",
        "recibidos_sin_condicion": "Casos sin condición",
        "recibidos_derivados": "Casos recibidos derivados",
        "recibidos_atendidos": "Casos derivados atendidos",
        "recibidos_pendiente_atencion": "Casos derivados pendientes de atención",
        "recibidos_sin_condicion_final": "Casos derivados sin condición final",
        "salientes": "Casos salientes",
        "salientes_atendidos": "Casos salientes atendidos",
        "salientes_pendiente_atencion": "Casos salientes pendientes de atención",
        "salientes_sin_condicion_final": "Casos salientes sin condición final",
        "calidad_campos_vacios": "Casos con ALERTA CAMPOS VACÍOS",
        "calidad_revision_derivacion": "Derivaciones con origen y destino iguales",
        "calidad_sin_recepcion": "Derivaciones sin fecha de recepción",
        "calidad_cerrado_sin_fecha": "Casos cerrados sin fecha de cierre",
        "calidad_fechas_inconsistentes": "Fechas previas al ingreso",
    }

    if detalle and detalle not in detail_masks and detalle != "dni":
        raise HTTPException(status_code=400, detail="La categoría de detalle no es válida.")
    if detalle == "dni" and not dni.strip():
        raise HTTPException(status_code=400, detail="Se requiere un DNI para consultar sus casos.")
    if pagina < 1:
        raise HTTPException(status_code=400, detail="El número de página debe ser mayor que cero.")
    if seguimiento_pagina < 1:
        raise HTTPException(status_code=400, detail="La página de seguimiento debe ser mayor que cero.")

    full_detail_columns = (
        "ID CASO",
        "FECHA INGRESO",
        "GESTOR",
        "ÁREA INICIAL",
        "EMPRESA",
        "CANAL",
        "TIPO CASO",
        "DNI",
        "CLIENTE",
        "MOTIVO",
        "SUBMOTIVO",
        "DETALLE DEL MOTIVO (VERSION DEL USUARIO)",
        "FECHA CIERRE",
        "CONDICIÓN USUARIO",
        "ÁREA DERIVADA",
        "ÁREA DE SALIDA",
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
    )
    nonderived_detail_columns = (
        "ID CASO",
        "FECHA INGRESO",
        "GESTOR",
        "ÁREA INICIAL",
        "EMPRESA",
        "CANAL",
        "TIPO CASO",
        "DNI",
        "CLIENTE",
        "MOTIVO",
        "SUBMOTIVO",
        "FECHA CIERRE",
        "CONDICIÓN USUARIO",
        "ALERTA CAMPOS VACÍOS",
        "DÍAS TRANSCURRIDOS",
        "DÍAS RECEPCIÓN DE DERIVADO",
        "ALERTA TIEMPO",
        "ALERTA SOLUCIÓN",
    )
    nonderived_details = {
        "recibidos_no_derivados",
        "recibidos_cerrados",
        "recibidos_pendiente_cierre",
        "recibidos_sin_condicion",
    }
    table_columns = (
        nonderived_detail_columns if detalle in nonderived_details else full_detail_columns
    )
    if detalle == "dni":
        table_cases = cases
        dni_values = table_cases["DNI"].map(
            lambda value: (
                str(int(value))
                if pd.api.types.is_number(value) and float(value).is_integer()
                else texto_limpio(value)
            )
        )
        table_cases = table_cases[dni_values.eq(dni.strip())]
    elif detalle:
        table_cases = sent if detalle.startswith("salientes") else received
        detail_mask = detail_masks[detalle]
        table_cases = table_cases[detail_mask]
        if detalle == "recibidos_derivados":
            if area_emisora:
                table_cases = filter_text(
                    table_cases, "ÁREA INICIAL", area_emisora, {"SIN ÁREA EMISORA"}
                )
            if gestor_emisor:
                table_cases = filter_text(
                    table_cases, "GESTOR", gestor_emisor, {"SIN RESPONSABLE"}
                )
    else:
        table_cases = sent if area_salida and not area else received

    if reporte_dia or reporte_estado or reporte_desde or reporte_hasta:
        user_condition = limpiar_columna(table_cases["CONDICIÓN USUARIO"])
        final_condition = limpiar_columna(table_cases["CONDICIÓN FINAL USUARIO"])
        closed_cases = user_condition.eq("CERRADO")
        attended_cases = user_condition.eq("DERIVADO") & final_condition.eq("ATENDIDO")
        solved_cases = mascara_solucionada(table_cases)
        entry_date_report = detalle in {
            "seguimiento_mensual",
            "recibidos_no_derivados",
            "recibidos_derivados",
            "salientes",
        }
        if entry_date_report:
            report_dates = table_cases["FECHA INGRESO"]
        else:
            report_dates = table_cases["FECHA FINAL"].where(attended_cases)
            report_dates = report_dates.where(~closed_cases, table_cases["FECHA CIERRE"])
            report_dates = report_dates.where(solved_cases, table_cases["FECHA INGRESO"])
        report_days = fechas_como_date(report_dates)
        unsolved_cases = mascara_no_solucionada(table_cases)

        if reporte_dia:
            table_cases = table_cases[
                (solved_cases & report_days.eq(reporte_dia))
                | (unsolved_cases & fechas_como_date(table_cases["FECHA INGRESO"]).eq(reporte_dia))
            ]
        elif reporte_desde or reporte_hasta:
            in_report_window = pd.Series(True, index=table_cases.index)
            if reporte_desde:
                in_report_window &= report_days >= reporte_desde
            if reporte_hasta:
                in_report_window &= report_days <= reporte_hasta
            table_cases = table_cases[in_report_window]

        if reporte_dia or reporte_desde or reporte_hasta:
            user_condition = limpiar_columna(table_cases["CONDICIÓN USUARIO"])
            final_condition = limpiar_columna(table_cases["CONDICIÓN FINAL USUARIO"])
            closed_cases = user_condition.eq("CERRADO")
            attended_cases = user_condition.eq("DERIVADO") & final_condition.eq("ATENDIDO")
            solved_cases = mascara_solucionada(table_cases)
            unsolved_cases = mascara_no_solucionada(table_cases)
            if entry_date_report:
                report_dates = table_cases["FECHA INGRESO"]
            else:
                report_dates = table_cases["FECHA FINAL"].where(attended_cases)
                report_dates = report_dates.where(~closed_cases, table_cases["FECHA CIERRE"])
                report_dates = report_dates.where(solved_cases, table_cases["FECHA INGRESO"])
            report_days = fechas_como_date(report_dates)

        if reporte_estado:
            is_advisor_report = detalle in {"seguimiento_semanal", "seguimiento_mensual"}
            is_nonderived = detalle == "recibidos_no_derivados"
            is_derived_received = detalle == "recibidos_derivados"
            if is_advisor_report:
                status_masks = {
                    "seguimiento_total": solved_cases | unsolved_cases,
                    "seguimiento_solucionado": solved_cases,
                    "seguimiento_no_solucionado": unsolved_cases,
                }
            elif is_nonderived:
                derived_same_area_cases = user_condition.eq("DERIVADO")
                status_masks = {
                    "cerrado": user_condition.eq("CERRADO"),
                    "pendiente": user_condition.eq("PENDIENTE"),
                    "sin_condicion": user_condition.eq(""),
                    "atendido": derived_same_area_cases & final_condition.eq("ATENDIDO"),
                    "pendiente_atencion": derived_same_area_cases & final_condition.eq("PENDIENTE"),
                    "sin_condicion_final": derived_same_area_cases & final_condition.eq(""),
                    "derivado_sin_destino_distinto": user_condition.eq("DERIVADO"),
                }
            elif is_derived_received:
                final_status = estados_condicion_final(table_cases)
                status_masks = {
                    "atendido": final_status.eq("atendido"),
                    "pendiente": final_status.eq("pendiente"),
                    "sin_condicion": final_status.eq("sin_condicion"),
                }
            else:
                final_status = estados_condicion_final(table_cases)
                status_masks = {
                    "atendido": final_status.eq("atendido"),
                    "pendiente": final_status.eq("pendiente"),
                    "sin_condicion": final_status.eq("sin_condicion"),
                }
            selected_status = status_masks.get(reporte_estado)
            if selected_status is None:
                raise HTTPException(status_code=400, detail="El estado del reporte no es válido.")
            if reporte_desde:
                selected_status &= report_days >= reporte_desde
            if reporte_hasta:
                selected_status &= report_days <= reporte_hasta
            table_cases = table_cases[selected_status]

    if caso_id.strip():
        selected_case_id = limpiar_columna(pd.Series([caso_id])).iloc[0]
        table_cases = table_cases[
            limpiar_columna(table_cases["ID CASO"]).eq(selected_case_id)
        ]

    table_cases = table_cases.sort_values("FECHA INGRESO", ascending=False)
    cases_total = len(table_cases)
    page_size = max(1, cases_total) if exportar_excel else (10 if detalle else 12)
    pages = max(1, (cases_total + page_size - 1) // page_size)
    if pagina > pages:
        raise HTTPException(status_code=400, detail="La página solicitada está fuera del rango.")
    page_cases = table_cases.iloc[(pagina - 1) * page_size:pagina * page_size]

    def serialize_case_value(column: str, value: object) -> str:
        if isinstance(value, pd.Timestamp) and not pd.isna(value):
            return value.strftime("%Y-%m-%d")
        if column == "DNI" and pd.api.types.is_number(value) and float(value).is_integer():
            return str(int(value))
        return texto_limpio(value)

    def serialize_case(row: dict[str, object], columns: tuple[str, ...]) -> dict[str, str]:
        source_area = texto_limpio(row.get("ÁREA INICIAL")).strip().upper()
        destination_area = texto_limpio(row.get("ÁREA DERIVADA")).strip().upper()
        is_derived_by_area = bool(destination_area) and destination_area != source_area
        serialized = {}
        for column in columns:
            value = row.get(column)
            normalized = texto_limpio(value).strip().upper()
            user_condition = texto_limpio(row.get("CONDICIÓN USUARIO")).strip().upper()
            if (
                column == "TIPO DE CASO DERIVADO"
                and user_condition == "CERRADO"
            ):
                serialized[column] = "—"
            elif column == "CONDICIÓN FINAL USUARIO" and not normalized:
                serialized[column] = "SIN CONDICIÓN" if user_condition == "DERIVADO" else "—"
            elif column == "CONDICIÓN USUARIO" and not normalized:
                serialized[column] = "SIN CONDICIÓN"
            elif (
                column == "RESPONSABLE DESTINO"
                and is_derived_by_area
                and normalized in {"", "SIN ASESOR", "SIN RESPONSABLE"}
            ):
                serialized[column] = "SIN ASESOR"
            else:
                serialized[column] = serialize_case_value(column, value)
        return serialized

    followup_columns = (
        "ID CASO",
        "FECHA INGRESO",
        "ASESOR FINAL",
        "ÁREA FINAL",
        "MOTIVO FINAL",
        "SUBMOTIVO FINAL",
        "DÍAS TRANSCURRIDOS",
        "ALERTA TIEMPO",
        "ALERTA CAMPOS VACÍOS",
    )
    followup_month_anchor = hasta or (
        cases["FECHA INGRESO"].dropna().max().date()
        if not cases["FECHA INGRESO"].dropna().empty
        else None
    )
    followup_month_start = (
        date(followup_month_anchor.year, followup_month_anchor.month, 1)
        if followup_month_anchor
        else None
    )
    followup_month_end = (
        date(
            followup_month_anchor.year + (followup_month_anchor.month == 12),
            followup_month_anchor.month % 12 + 1,
            1,
        )
        if followup_month_anchor
        else None
    )
    if followup_month_start and followup_month_end:
        followup_source = followup_source[
            (followup_source["FECHA INGRESO"] >= pd.Timestamp(followup_month_start))
            & (followup_source["FECHA INGRESO"] < pd.Timestamp(followup_month_end))
        ]

    followup_ids = limpiar_columna(followup_source["ID CASO"]).ne("")
    followup_incoming = pd.to_numeric(
        followup_source["SUMA TOTAL INGRESADOS"], errors="coerce"
    ).eq(1)
    followup_outgoing = pd.to_numeric(
        followup_source["SUMA CASOS SALIENTES"], errors="coerce"
    ).eq(1)
    followup_derived = mascara_derivado_por_area(followup_source)
    if outgoing_mode:
        followup_cases = followup_source[followup_ids & followup_outgoing & followup_derived]
        if area:
            followup_cases = filter_by_attributed_area(followup_cases, "ÁREA INICIAL", area)
    elif category_selection == "RECIBIDOS_NO_DERIVADOS":
        followup_cases = followup_source[followup_ids & followup_incoming & ~followup_derived]
        if area:
            followup_cases = filter_by_attributed_area(followup_cases, "ÁREA INICIAL", area)
    elif category_selection == "RECIBIDOS_DERIVADOS":
        followup_cases = followup_source[followup_ids & followup_incoming & followup_derived]
        if area:
            followup_cases = filter_by_attributed_area(followup_cases, "ÁREA DERIVADA", area)
    else:
        followup_cases = followup_source[followup_ids & followup_incoming]
        if area:
            followup_nonderived = followup_cases[~mascara_derivado_por_area(followup_cases)]
            followup_derived_received = followup_cases[mascara_derivado_por_area(followup_cases)]
            followup_nonderived = filter_by_attributed_area(
                followup_nonderived, "ÁREA INICIAL", area
            )
            followup_derived_received = filter_by_attributed_area(
                followup_derived_received, "ÁREA DERIVADA", area
            )
            followup_cases = pd.concat(
                [followup_nonderived, followup_derived_received]
            ).sort_index()

    if buscar.strip():
        followup_search_columns = [
            column
            for column in (
                "ID CASO",
                "ÁREA INICIAL",
                "ÁREA FINAL",
                "ÁREA QUE SUMA EL INGRESO",
                "ÁREA DE SALIDA",
                "ASESOR FINAL",
                "TIPO CASO FINAL",
                "MOTIVO FINAL",
                "SUBMOTIVO FINAL",
                "EMPRESA",
            )
            if column in followup_cases.columns
        ]
        followup_search_match = pd.Series(False, index=followup_cases.index)
        for column in followup_search_columns:
            followup_search_match |= followup_cases[column].fillna("").astype(str).str.contains(
                buscar.strip(), case=False, regex=False
            )
        followup_cases = followup_cases[followup_search_match]

    followup_cases = followup_cases[mascara_no_solucionada(followup_cases)].sort_values(
        "FECHA INGRESO",
        ascending=False,
    )
    followup_total = len(followup_cases)
    followup_page_size = 20
    followup_pages = max(1, (followup_total + followup_page_size - 1) // followup_page_size)
    if seguimiento_pagina > followup_pages:
        raise HTTPException(status_code=400, detail="La página de seguimiento está fuera del rango.")
    followup_page = followup_cases.iloc[
        (seguimiento_pagina - 1) * followup_page_size:seguimiento_pagina * followup_page_size
    ]

    missing_field_labels = {
        "SIN MOTIVO": "motivo",
        "SIN SUBMOTIVO": "submotivo",
        "SIN CONDICIÓN": "condición del usuario",
        "CERRADO | SIN FECHA DE CIERRE": "fecha de cierre",
        "SIN ÁREA DERIVADA": "área derivada",
        "SIN FECHA RECEPCIÓN": "fecha de recepción",
        "SIN RESPONSABLE DE ATENCIÓN": "responsable de atención",
        "SIN TIPO DE CASO DERIVADO": "tipo de caso derivado",
        "SIN MOTIVO DERIVADO": "motivo derivado",
        "SIN SUBMOTIVO DERIVADO": "submotivo derivado",
        "ATENDIDO | SIN FECHA FINAL": "fecha final",
    }

    def followup_observation(row: dict[str, object]) -> str:
        condition = texto_limpio(row.get("CONDICIÓN USUARIO")).strip().upper()
        final_condition = texto_limpio(row.get("CONDICIÓN FINAL USUARIO")).strip().upper()
        time_alert = texto_limpio(row.get("ALERTA TIEMPO")).strip().upper()
        elapsed = texto_limpio(row.get("DÍAS TRANSCURRIDOS"))
        try:
            elapsed_days = int(float(elapsed))
        except (OverflowError, ValueError):
            elapsed_days = None

        actions = []
        is_solved = condition == "CERRADO" or (
            condition == "DERIVADO" and final_condition == "ATENDIDO"
        )
        if not is_solved and time_alert == "VENCIDO > 7 DÍAS":
            days_text = f" ({elapsed_days} días sin resolución)" if elapsed_days is not None else ""
            actions.append(f"Priorizar la atención y definir el cierre o derivación{days_text}.")
        elif not is_solved and time_alert == "ALERTA 3-7 DÍAS":
            actions.append("Dar seguimiento prioritario para evitar que supere los 7 días.")
        elif not is_solved and condition == "PENDIENTE":
            actions.append("Continuar la gestión y definir si corresponde cerrar o derivar el caso.")
        elif not is_solved and condition == "DERIVADO":
            actions.append("Confirmar la atención y el cierre con el área responsable de la derivación.")
        elif not is_solved:
            actions.append("Continuar con la gestión al día.")

        warnings = texto_limpio(row.get("ALERTA CAMPOS VACÍOS")).strip().upper()
        missing_fields = [
            label
            for warning, label in missing_field_labels.items()
            if warning in warnings
        ]
        if missing_fields:
            actions.append(f"Completar los campos de {', '.join(missing_fields)}.")

        return " ".join(actions) if actions else "Continuar con la gestión al día."

    table = [
        serialize_case(row, table_columns)
        for row in page_cases[list(table_columns)].to_dict(orient="records")
    ]
    if exportar_excel:
        export_frame = pd.DataFrame(table, columns=table_columns)
        for column in ("FECHA INGRESO", "FECHA CIERRE", "FECHA RECEPCIÓN", "FECHA FINAL"):
            if column in export_frame.columns:
                export_frame[column] = pd.to_datetime(export_frame[column], errors="coerce")

        output = BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            export_frame.to_excel(writer, index=False, sheet_name="Casos")
            worksheet = writer.sheets["Casos"]
            worksheet.freeze_panes = "A2"
            worksheet.auto_filter.ref = worksheet.dimensions
        output.seek(0)
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="casos-filtrados.xlsx"'},
        )

    followup_records = []
    for row in followup_page.to_dict(orient="records"):
        serialized = serialize_case(row, followup_columns)
        serialized["OBSERVACIÓN"] = followup_observation(row)
        followup_records.append(serialized)

    detail_title = (
        f"Detalle del caso {caso_id.strip()}"
        if caso_id.strip()
        else f"Todos los casos asociados al DNI {dni.strip()}"
        if detalle == "dni"
        else detail_titles.get(detalle, "Detalle de casos recientes")
    )
    if detalle == "salientes" and area_destino:
        detail_title = f"Derivaciones de {area_salida or area} a {area_destino}"

    filter_columns = {
        "areas": "ÁREA INICIAL",
        "areas_salida": "ÁREA DERIVADA",
        "gestores": "ASESOR FINAL",
        "tipos": "TIPO CASO FINAL",
        "motivos": "MOTIVO FINAL",
        "submotivos": "SUBMOTIVO FINAL",
        "empresas": "EMPRESA",
        "canales": "CANAL",
    }
    options = {
        name: opciones_columna(cases, column)
        for name, column in filter_columns.items()
    }
    options["areas"] = sorted(set(options["areas"]) | set(options["areas_salida"]))
    classification_columns = ["TIPO CASO FINAL", "MOTIVO FINAL", "SUBMOTIVO FINAL"]
    classification_rows = cases[classification_columns].copy()
    for column in classification_columns:
        classification_rows[column] = limpiar_columna(classification_rows[column])
    motive_hierarchy = [
        {"tipo": case_type, "motivo": reason, "submotivo": subreason}
        for case_type, reason, subreason in sorted(
            set(classification_rows.itertuples(index=False, name=None))
        )
        if case_type and reason
    ]

    advisor_directory_pairs = pd.DataFrame({
        "_directory_area": cases["ÁREA FINAL"].fillna("").astype(str).str.strip(),
        "_directory_advisor": cases["ASESOR FINAL"].fillna("").astype(str).str.strip(),
    }).loc[lambda pairs: pairs["_directory_advisor"].ne("")].drop_duplicates()
    advisor_directory_pairs["_directory_area"] = advisor_directory_pairs[
        "_directory_area"
    ].replace("", "SIN ÁREA")
    advisor_directory_pairs["_directory_advisor"] = advisor_directory_pairs[
        "_directory_advisor"
    ].replace("", "SIN ASESOR")
    advisor_directory = [
        {"area": area, "asesor": advisor}
        for area, advisor in advisor_directory_pairs.sort_values(
            ["_directory_area", "_directory_advisor"]
        ).itertuples(index=False, name=None)
    ]

    return {
        "archivo_cargado": _cases_uploaded_filename,
        "origen_datos": _cases_source,
        "aviso_datos": _cases_source_warning,
        "actualizado_en": _cases_source_updated_at,
        "version_fuente": _cases_source_version,
        "categoria": category_selection,
        "modo_saliente": outgoing_mode,
        "total_base": int(len(cases)),
        "periodo": {
            "desde": date_series.min().strftime("%Y-%m-%d") if not date_series.empty else None,
            "hasta": date_series.max().strftime("%Y-%m-%d") if not date_series.empty else None,
        },
        "directorio_asesores": advisor_directory,
        "jerarquia_motivos": motive_hierarchy,
        "kpis": {
            "total": active_total,
            "recibidos_no_derivados": suma_columna(
                received,
                summary_count_column,
                received_nonderived,
            ),
            "recibidos_derivados": suma_columna(
                received,
                summary_count_column,
                received_derived,
            ),
            "salientes": outflow_total,
            "salientes_solucionados": outgoing_solved,
            "salientes_no_solucionados": outgoing_unsolved,
            "salientes_pendiente_atencion": outgoing_attention_pending,
            "salientes_sin_condicion_final": outgoing_missing_final_condition,
            "salientes_atendidos": outgoing_attended,
            "solucionados": solved,
            "no_solucionados": unsolved,
            "cerrados": solved_closing,
            "atendidos_derivados": solved_attention,
            "vencidos": overdue,
            "alerta_3_7_dias": at_risk,
            "en_plazo": in_time,
            "pendientes_cierre": close_pending,
            "pendientes_atencion": attention_pending,
            "consultas": suma_columna(
                received, summary_count_column, limpiar_columna(received["TIPO CASO FINAL"]).eq("CONSULTA")
            ),
            "reclamos": suma_columna(
                received, summary_count_column, limpiar_columna(received["TIPO CASO FINAL"]).eq("RECLAMO")
            ),
            "sin_clasificar": int(
                received["TIPO CASO FINAL"].fillna("").astype(str).str.strip().eq("").sum()
            ),
            "revision_calidad": quality_issues,
            "derivaciones_sin_fecha_recepcion": reception_missing,
            "fechas_inconsistentes": date_issues,
            "cierre_sin_condicion": close_missing_condition,
            "pendiente_cierre": close_pending,
            "cerrados_no_derivados": suma_columna(received, summary_count_column, closed_nonderived),
            "derivados_mismo_area_revisar": suma_columna(
                received,
                "SUMA TOTAL INGRESADOS",
                received["VALIDACIÓN DE DERIVACIÓN"]
                .fillna("")
                .astype(str)
                .str.startswith("REVISAR"),
            ),
            "pendiente_atencion": suma_columna(received, summary_count_column, pending_derived),
            "sin_condicion_final": attention_missing_condition,
            "atendidos_derivados": suma_columna(received, summary_count_column, attended_derived),
        },
        "por_tipo": by_type,
        "por_area_receptora": receiving_areas,
        "derivados_recibidos_por_area": receiving_derived_areas,
        "por_area_remitente": sending_areas,
        "derivaciones_por_area": area_flows,
        "por_empresa": distribucion(received, "EMPRESA", limit=8),
        "por_canal": distribucion(received, "CANAL", limit=8),
        "por_motivo": distribucion(received, "MOTIVO FINAL", limit=10),
        "por_submotivo": distribucion(received, "SUBMOTIVO FINAL", limit=None),
        "desglose_motivos_tipo": motive_breakdown,
        "totales_desglose_motivos_tipo": motive_breakdown_totals,
        "por_anio": yearly,
        "por_mes": monthly,
        "por_semana": weekly,
        "por_dia": daily,
        "seguimiento_semanal_asesores": {
            "desde": week_days[0].isoformat(),
            "hasta": week_days[-1].isoformat(),
            "dias": [day.isoformat() for day in week_days],
            "registros": advisor_week_data,
        },
        "resumen_asesores": {
            "desde": advisor_period_start,
            "hasta": advisor_period_end,
            "registros": advisor_period_data,
        },
        "resumen_eficiencia_areas": {
            "registros": area_efficiency_rows,
            "total": area_efficiency_total,
        },
        "resumen_eficiencia_asesores": advisor_efficiency_rows,
        "cuadro_empresas": company_comparison,
        "cuadro_canales": channel_comparison,
        "seguimiento_mensual_asesores": {
            "desde": advisor_month_start.isoformat(),
            "hasta": (advisor_month_end - timedelta(days=1)).isoformat(),
            "registros": advisor_month_data,
        },
        "tendencia_mensual_asesores": advisor_trend_data,
        "flujo_semanal_asesores": {
            "categoria": category_selection,
            "desde": week_days[0].isoformat(),
            "hasta": week_days[-1].isoformat(),
            "dias": [day.isoformat() for day in week_days],
            "recibidos_no_derivados": advisor_nonderived_week,
            "recibidos_derivados": advisor_derived_received_week,
            "salientes": advisor_outgoing_week,
        },
        "casos": table,
        "seguimiento_casos": {
            "casos": followup_records,
            "total": followup_total,
            "pagina": seguimiento_pagina,
            "paginas": followup_pages,
            "periodo_desde": followup_month_start.isoformat() if followup_month_start else None,
            "periodo_hasta": (
                (followup_month_end - timedelta(days=1)).isoformat()
                if followup_month_end
                else None
            ),
        },
        "casos_total": cases_total,
        "pagina": pagina,
        "paginas": pages,
        "detalle": detalle,
        "detalle_titulo": detail_title,
        "columnas_casos": list(table_columns),
        "opciones": options,
        "revision_calidad": quality_issues,
        "calidad": quality_categories,
    }