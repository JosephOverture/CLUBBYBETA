# Beta web con backend

`web/` conserva la beta de 28 locales de `Clubby-GitHub.zip`. `apps/api` y `apps/worker` conservan la plataforma TypeScript/NestJS original. `apps/mobile` conserva su cliente Expo y sus paneles de operación.

## Peticiones

El navegador abre `http://localhost:8081`. `scripts/beta-server.mjs` sirve exclusivamente `web/` y reenvía `/v1/*` y `/health/*` a la API. El navegador utiliza un solo origen; la configuración pública no incluye credenciales.

- `GET /v1/venues?city=milano&limit=100`: catálogo desde PostgreSQL; `milano` es alias de `milan`.
- `GET /v1/beta/state`: crea o recupera la sesión del visitante.
- `PUT /v1/beta/saved/:venueId` con `{saved:true|false}`.
- `POST /v1/beta/plans` con `{venueId,name,note,date}`.
- `DELETE /v1/beta/plans/:id`.
- `PATCH /v1/beta/profile` con `{name?,theme?}`.
- `DELETE /v1/beta/state`: elimina los datos personales y caduca la cookie.

Los endpoints de estado devuelven `{data:{saved,plans,profile}}`. Los planes son personales; no generan reservas, cobros ni entradas. Las compras se realizan en la web oficial del local.

## Persistencia

PostgreSQL guarda favoritos, planes, nombre y tema. La cookie `clubby_beta` contiene un token aleatorio de 256 bits, es HttpOnly y SameSite=Lax, y caduca a los 90 días; en staging/producción también exige HTTPS. El servidor almacena el hash del token. Cada visitante tiene registros separados. Las mutaciones exigen un Origin incluido en `WEB_ORIGINS`.

La sesión pertenece a este navegador y no sincroniza dispositivos. Borrar cookies pierde el acceso a la sesión; borrar datos desde el perfil elimina sus registros del servidor. Los registros caducados se eliminan en lotes acotados al crear nuevas sesiones.

El frontend muestra las modificaciones tras confirmación del servidor y presenta los errores. No cambia silenciosamente al catálogo local si falla la API. `dataMode:'catalogue'` en `web/config.js` permite una vista previa explícita sin backend, con aviso visible y almacenamiento local.

## Datos y migraciones

`database/seeds/milan-venues.json` contiene el catálogo recuperado. El seed inserta registros sin sobrescribir cambios de vendedores. Solo actualiza la antigua ficha demo de Alcatraz si coincide exactamente con la original intacta. `web/src/seed.js` conserva el catálogo para la vista previa; ambos deben mantenerse sincronizados.

Las migraciones 022 y 023 añaden sesiones y metadatos de presentación. Las anteriores permanecen intactas. El servicio comprueba checksums y rechaza bases de datos de otro entorno.

## Alojamiento

GitHub permite revisar el código; GitHub Pages no ejecuta NestJS ni PostgreSQL. Una beta compartida necesita la API existente, worker, PostgreSQL persistente y `Dockerfile.beta` para la web. Configurar `API_TARGET` en la web con el origen interno de la API, y `WEB_ORIGINS` en la API con el origen HTTPS público de la web. Las credenciales pertenecen al entorno del alojamiento.

`Dockerfile.web` original sigue siendo el cliente Expo. Los runbooks originales documentan TLS y despliegue de la plataforma. Pagos, wallets, correo real e iOS requieren sus cuentas y configuración externas; el arranque local mantiene el comercio real desactivado.

Después de migrar un entorno desplegado, ejecutar explícitamente `node dist/import-catalogue.js` con sus variables de conexión. Importa las fichas editoriales sin datos de comercio de demostración y conserva los registros existentes. En desarrollo, el arranque local ya realiza esta importación mediante `db:seed`.
