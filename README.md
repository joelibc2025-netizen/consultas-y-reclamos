# Dashboard de gestión de consultas y reclamos

## Fuente de datos de SharePoint

El dashboard usa `SHAREPOINT_EXCEL_URL` como fuente principal. Configúrala con el enlace de descarga de SharePoint antes de iniciar el servidor; no guardes el enlace en el código:

```powershell
$env:SHAREPOINT_EXCEL_URL = "https://tu-empresa.sharepoint.com/..."
.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

El enlace debe permitir descargar el archivo directamente; si SharePoint responde con HTTP 401/403 o exige iniciar sesión de forma interactiva, la descarga automática necesita autenticación de Microsoft.

Al abrir el dashboard, el servidor intenta descargar y validar el Excel. Mientras haya una sesión abierta, el navegador vuelve a consultar los datos cada cinco minutos y al regresar a la pestaña. Cada descarga válida reemplaza de forma segura el respaldo local en `data\ATENCION Y GESTION.xlsx`. Si SharePoint no responde, se conserva el último respaldo válido y el dashboard muestra un aviso.

La carga manual de Excel sigue disponible; al cumplirse el siguiente ciclo, SharePoint vuelve a ser la fuente principal. Si no se configura `SHAREPOINT_EXCEL_URL`, el servidor usa el Excel local disponible y muestra un aviso de configuración.

## Sincronización desde una PC

Como alternativa a SharePoint, el endpoint `POST /api/sincronizar-excel` recibe el archivo Excel, lo valida y actualiza el respaldo que usa el dashboard. Requiere un token Bearer; sin `DASHBOARD_SYNC_TOKEN`, el endpoint queda deshabilitado. Recibe el Excel como archivo multipart, no el JSON de `/api/sincronizar-datos` del ejemplo. Configura el mismo token como secreto en el servidor desplegado y como variable de entorno en la PC. Genera un valor aleatorio y no lo guardes en el código:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

En el servicio cloud, configura `DASHBOARD_SYNC_TOKEN` en sus variables secretas y despliega la aplicación. Si usas este puente, deja `SHAREPOINT_EXCEL_URL` sin definir en ese servicio para que no reemplace los datos recibidos. En PowerShell de la PC, configura la URL real del servicio y ejecuta el puente:

```powershell
$env:DASHBOARD_SYNC_URL = "https://tu-dominio-real/api/sincronizar-excel"
$env:DASHBOARD_SYNC_TOKEN = "el-mismo-token-secreto"
.\venv\Scripts\python.exe .\puente_sincronizacion.py
```

El puente usa por defecto `~\OneDrive - Escuela Iberoamericana del Docente SAC\Documentos\proyecto_dashboard\Gestión de Consultas y Reclamos - ATC Académico - IBC Institute.xlsx`. Si el archivo está en otra ubicación, configura `EXCEL_LOCAL_PATH` con su ruta completa. El puente usa HTTPS para servidores remotos y permite HTTP únicamente en `localhost`. No compartas el token ni lo incluyas en archivos versionados. La sincronización no se ejecutará contra un destino de plantilla: primero debes reemplazar la URL por la dirección HTTPS real de tu servicio.

Un acceso directo de Internet (incluso si se renombra con extensión `.xlsx`) no es el libro de Excel; el puente lo rechazará. OneDrive debe sincronizar el archivo `.xlsx` real en el equipo para poder leer la hoja y enviarla.

El servidor conserva el último Excel válido en su disco local. Si el proveedor cloud usa almacenamiento efímero, configura un disco persistente o vuelve a ejecutar el puente después de reinicios o despliegues.
