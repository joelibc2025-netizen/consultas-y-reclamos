import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from uuid import uuid4


PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_EXCEL_PATH = (
    Path.home()
    / "OneDrive - Escuela Iberoamericana del Docente SAC"
    / "Documentos"
    / "proyecto_dashboard"
    / "Gestión de Consultas y Reclamos - ATC Académico - IBC Institute.xlsx"
)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def crear_cuerpo_multipart(
    filename: str,
    content: bytes,
    boundary: str,
) -> bytes:
    safe_filename = (
        Path(filename).name.replace('"', "_").replace("\r", "_").replace("\n", "_")
    )
    return b"".join(
        (
            f"--{boundary}\r\n".encode("ascii"),
            (
                'Content-Disposition: form-data; name="archivo"; '
                f'filename="{safe_filename}"\r\n'
            ).encode("utf-8"),
            b"Content-Type: application/vnd.openxmlformats-officedocument."
            b"spreadsheetml.sheet\r\n\r\n",
            content,
            f"\r\n--{boundary}--\r\n".encode("ascii"),
        )
    )


def validar_url(url: str) -> None:
    parsed_url = urlparse(url)
    if parsed_url.scheme == "https" and parsed_url.hostname:
        return
    if (
        parsed_url.scheme == "http"
        and parsed_url.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        return
    raise ValueError(
        "DASHBOARD_SYNC_URL debe usar HTTPS; HTTP solo se permite para localhost."
    )


def validar_archivo_excel(excel_path: Path) -> str | None:
    if excel_path.suffix.lower() == ".url":
        return (
            f"'{excel_path}' es un acceso directo de Internet (.url), no un Excel. "
            "Sincroniza el archivo .xlsx real con OneDrive."
        )
    if excel_path.suffix.lower() not in {".xlsx", ".xlsm"}:
        return "EXCEL_LOCAL_PATH debe apuntar a un archivo .xlsx o .xlsm."
    if not excel_path.is_file():
        shortcut_path = Path(f"{excel_path}.url")
        if shortcut_path.is_file():
            return (
                f"Solo se encontró el acceso directo '{shortcut_path}', no el Excel. "
                "Sincroniza el archivo .xlsx real con OneDrive."
            )
        return (
            f"No se encontró el Excel '{excel_path}'. "
            "Verifica la sincronización de OneDrive o configura EXCEL_LOCAL_PATH."
        )
    return None


def validar_contenido_excel(content: bytes) -> str | None:
    prefix = content[:128].decode("utf-8-sig", errors="ignore").lstrip().lower()
    if prefix.startswith("[internetshortcut]") or prefix.startswith("url="):
        return (
            "El archivo tiene contenido de acceso directo a Internet, "
            "no contiene el libro Excel. Sincroniza el .xlsx real con OneDrive."
        )
    return None


def sincronizar() -> int:
    url = os.environ.get("DASHBOARD_SYNC_URL", "").strip()
    token = os.environ.get("DASHBOARD_SYNC_TOKEN", "").strip()
    excel_path = Path(
        os.environ.get("EXCEL_LOCAL_PATH", str(DEFAULT_EXCEL_PATH))
    ).expanduser()

    if not url:
        print("Falta configurar la variable DASHBOARD_SYNC_URL.", file=sys.stderr)
        return 1
    if not token:
        print("Falta configurar la variable DASHBOARD_SYNC_TOKEN.", file=sys.stderr)
        return 1
    try:
        validar_url(url)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1

    path_error = validar_archivo_excel(excel_path)
    if path_error:
        print(path_error, file=sys.stderr)
        return 1

    try:
        content = excel_path.read_bytes()
    except OSError as error:
        print(
            f"No se pudo leer el Excel '{excel_path}'. Detalle: {error}",
            file=sys.stderr,
        )
        return 1

    if not content:
        print("El archivo Excel está vacío.", file=sys.stderr)
        return 1
    if len(content) > MAX_UPLOAD_BYTES:
        print("El archivo Excel supera el límite de 50 MB.", file=sys.stderr)
        return 1
    content_error = validar_contenido_excel(content)
    if content_error:
        print(content_error, file=sys.stderr)
        return 1

    boundary = f"----dashboard-sync-{uuid4().hex}"
    request = Request(
        url,
        data=crear_cuerpo_multipart(excel_path.name, content, boundary),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            error_response = json.loads(error.read().decode("utf-8"))
            details = (
                error_response.get("detail")
                if isinstance(error_response, dict)
                else None
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            details = None
        message = details or f"El servidor respondió HTTP {error.code}."
        print(f"Error al sincronizar: {message}", file=sys.stderr)
        return 1
    except URLError as error:
        print(f"No se pudo conectar con el servidor: {error.reason}", file=sys.stderr)
        return 1
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"El servidor devolvió una respuesta inválida: {error}", file=sys.stderr)
        return 1

    if not isinstance(result, dict) or "registros" not in result:
        print("El servidor devolvió una respuesta inesperada.", file=sys.stderr)
        return 1

    print(
        f"Sincronización exitosa: {result['registros']} registros "
        f"desde '{excel_path.name}'."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(sincronizar())
