# Entregar Clubby al equipo

Destino indicado: `P4210/Project-Clubby`. Esta entrega integra frontend y backend; volver a subir el ZIP anterior no incorpora estos cambios.

## Rama de revisión

Clonar el repositorio existente para conservar su historial. No reemplazar su carpeta `.git` ni hacer force push.

```sh
git clone https://github.com/P4210/Project-Clubby.git Clubby-review
cd Clubby-review
git switch -c review/clubby-full-stack
```

Copiar esta entrega a esa copia, incluyendo `.github/`, `.gitignore`, `.env.example` y `.dockerignore`. Conservar `.git` de la copia clonada. Excluir `node_modules/`, `.local-tools/`, `.local-data/`, `.env`, certificados y builds.

```sh
pnpm install --frozen-lockfile
pnpm check
git add .
git diff --cached --stat
git diff --cached
git commit -m "Connect Clubby beta to persistent backend"
git push -u origin review/clubby-full-stack
```

Abrir un pull request hacia la rama principal existente. El equipo puede revisar, clonar la rama y ejecutar `pnpm local --web`. Los colaboradores de un repositorio privado necesitan acceso.

## Revisión funcional

1. Abrir `http://localhost:8081`; buscar y filtrar los 28 locales, detalles, mapa y enlaces oficiales.
2. Guardar un local y crear un plan personal.
3. Cambiar nombre o tema y recargar: los datos deben seguir presentes.
4. Reiniciar `pnpm local --web`: los datos deben seguir presentes.
5. Abrir otra sesión privada: no debe ver los datos de la primera.
6. Borrar los datos desde el perfil y comprobar que desaparecen.

Localhost solo funciona en el ordenador que ejecuta la aplicación. Probar sin instalar requiere desplegar web, API y base de datos; subir código a GitHub no crea ese alojamiento.
