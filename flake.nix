{
  description = "DocLight - 轻量可视化文档站";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin" # nixpkgs removed x86_64-darwin as of 26.11
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # Single package definition, reused by packages / checks / nixosModules.
      mkPackage =
        pkgs:
        pkgs.buildNpmPackage {
          pname = "doclight";
          version = "1.1.0";
          src = self;

          # Hashes are taken straight from the `integrity` fields of package-lock.json,
          # so adding or updating a dependency no longer requires recomputing a
          # fixed-output hash (the old npmDepsHash drifted on every manifest change).
          # Both attributes must be set together, otherwise npmDeps is not wired in.
          # `npmRoot` takes `self` directly, not the sibling `src` binding: attribute
          # values are not in each other's scope without `rec`, so referencing `src`
          # here is an undefined variable at evaluation time.
          npmDeps = pkgs.importNpmLock { npmRoot = self; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          # `npm run build` compiles the server, bundles the browser app (esbuild) and
          # compiles the tests. esbuild's platform binary comes from npm's optional
          # dependencies, which `importNpmLock` derives from package-lock.json.
          npmBuildScript = "build";

          # The default npmInstallHook packs the package with `npm pack`, which honours
          # .gitignore — and .gitignore lists dist/ and public/app.js, so the compiled
          # artifacts would be silently dropped: the build would succeed and the package
          # would crash on start. package.json therefore carries a `files` whitelist,
          # which takes precedence over .gitignore and ships exactly:
          #   dist/server.js, dist/beian.js, dist/config.js, dist/markdown.js,
          #   dist/store.js, dist/sort.js, public/, template/
          # The whitelist names the compiled files individually instead of `dist/` so the
          # compiled tests (which `require('jsdom')`, a devDependency pruned from the
          # output) stay out. `template/` is the first-run sample site (spaces.json + pages/*.md).
          #
          # Layout matters: server.js resolves its root as `__dirname/..`, and in the
          # packed tree `public/` and `template/` sit next to `dist/`, so
          # `lib/node_modules/doclight/dist/server.js` makes `lib/node_modules/doclight`
          # the root.
          nativeBuildInputs = [ pkgs.makeWrapper ];

          # The wrapper only supplies a writable data directory for the no-config case:
          # the store is read-only, so `dataDir` would otherwise default to a path under
          # it. It must not inject DOCLIGHT_DATA_DIR when the user pointed at a config
          # file — the environment outranks the file, so doing so would silently override
          # the file's `dataDir`, contradicting "environment variables are a temporary
          # override". With DOCLIGHT_CONFIG set, the file owns `dataDir`; a config used
          # under `nix run` must therefore set it (or DOCLIGHT_DATA_DIR explicitly).
          postInstall = ''
            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/doclight \
              --add-flags $out/lib/node_modules/doclight/dist/server.js \
              --run 'if [ -z "''${DOCLIGHT_CONFIG:-}" ] && [ -z "''${DOCLIGHT_DATA_DIR:-}" ]; then export DOCLIGHT_DATA_DIR="''${XDG_DATA_HOME:-$HOME/.local/share}/doclight"; fi'
          '';

          meta = {
            description = "轻量可视化文档站：浏览器里直接排版，保存即刻生效";
            homepage = "https://github.com/Mooling0602/DocLight";
            mainProgram = "doclight";
            platforms = systems;
          };
        };
    in
    {
      packages = forAllSystems (system: {
        default = mkPackage nixpkgs.legacyPackages.${system};
      });

      # nix run .              → writes data to ${XDG_DATA_HOME:-~/.local/share}/doclight
      # PORT=8080 nix run .    → start scanning from another port (env overrides config)
      # DOCLIGHT_DATA_DIR=/tmp/docs nix run .
      # DOCLIGHT_CONFIG=/path/to/doclight.toml nix run .
      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/doclight";
          meta.description = "启动 DocLight 文档站";
        };
      });

      checks = forAllSystems (system: {
        # Reuse the package derivation but run `npm test` in the populated build
        # directory, where the jsdom devDependency is still present.
        tests = (mkPackage nixpkgs.legacyPackages.${system}).overrideAttrs (old: {
          pname = old.pname + "-tests";
          doCheck = true;
          checkPhase = ''
            runHook preCheck
            npm test
            runHook postCheck
          '';
          installPhase = "mkdir -p $out";
        });
      });

      devShells = forAllSystems (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = with nixpkgs.legacyPackages.${system}; [
            nodejs_22
            typescript-language-server
            nixfmt
          ];
        };
      });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);

      # NixOS module: services.doclight.enable = true;
      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.doclight;
          pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.default;

          # Merge order (low → high): module defaults < settings < fine-grained options.
          # Each layer is filtered on its own *before* merging: `//` is right-biased, so
          # `notNull { port = cfg.port; ... } // notNull cfg.settings` would otherwise let a
          # null fine-grained option wipe an explicit `settings.port` and then vanish.
          notNull = lib.filterAttrs (_: v: v != null);

          # Fallbacks applied only when neither settings nor a fine-grained option set the
          # key. These may differ from the application defaults on purpose: the app binds
          # all interfaces, while the module keeps the safer loopback default.
          moduleDefaults = {
            port = 4173;
            host = "127.0.0.1";
          };

          fineGrained = notNull {
            port = cfg.port;
            host = cfg.address;
            icp = cfg.icp;
            icpUrl = cfg.icpUrl;
            police = cfg.police;
            policeUrl = cfg.policeUrl;
            copyright = cfg.copyright;
          };

          finalSettings = notNull moduleDefaults // notNull cfg.settings // fineGrained;

          # Service-forced keys, injected last so they cannot be overridden. strictPort pins
          # the reverse proxy to one port; dataDir must match StateDirectory/WorkingDirectory
          # below, otherwise the DynamicUser has no write access.
          serviceSettings = finalSettings // {
            strictPort = true;
            dataDir = "/var/lib/doclight";
          };

          # The generated file carries the filing info, which is exactly what used to be
          # passed through `environment` and could be truncated there by systemd's parsing.
          configFile = (pkgs.formats.toml { }).generate "doclight.toml" serviceSettings;

          # The firewall must use the merged value, not cfg.port (which may be null).
          effectivePort = serviceSettings.port;
        in
        {
          options.services.doclight = {
            enable = lib.mkEnableOption "DocLight 轻量可视化文档站";

            package = lib.mkOption {
              type = lib.types.package;
              default = pkg;
              description = "DocLight 包。";
            };

            settings = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
              example = {
                port = 8100;
                icp = "浙ICP备12345678号-1";
              };
              description = ''
                直接写入生成 TOML 的配置项，用于覆盖细粒度选项之外或将来新增的键。
                细粒度选项（port / address / icp / police / copyright ...）优先级更高，
                未设置（null）的项不会写入文件。
              '';
            };

            port = lib.mkOption {
              type = lib.types.nullOr lib.types.port;
              default = null;
              description = ''
                监听端口，写入生成的 TOML。未设置时模块使用 4173；
                默认值保持 null 是为了让 `settings.port` 仍然生效（细粒度选项优先级更高）。
                `nixos-option services.doclight.port` 因此显示 null，属预期行为。
              '';
            };

            address = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                监听地址，写入生成的 TOML。默认只绑定回环（127.0.0.1），
                公网访问请经反向代理转发；需要直接对外暴露时可设为 "0.0.0.0" 并打开 openFirewall。
                未设置时模块使用 127.0.0.1。
              '';
            };

            openFirewall = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "是否放行防火墙端口。";
            };

            icp = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "浙ICP备12345678号-1";
              description = ''
                网站备案号，悬挂在页面底部并链接至工信部备案管理系统。
                中国大陆服务器对外提供服务时必须填写，否则会被责令整改。
              '';
            };

            icpUrl = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "https://beian.miit.gov.cn/";
              description = "备案号指向的链接；留空时使用工信部备案管理系统。";
            };

            police = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "京公网安备11010502030123号";
              description = ''
                公安联网备案号（可选），同样悬挂在页面底部。
                链接默认按号码中的数字段自动指向公安部查询页。
              '';
            };

            policeUrl = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "公安备案号指向的链接；留空时按备案号自动生成查询链接。";
            };

            copyright = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "© 2026 Mooling";
              description = "版权行（可选），显示在备案号左侧。";
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.doclight = {
              description = "DocLight - 轻量可视化文档站";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];

              serviceConfig = {
                ExecStart = lib.getExe cfg.package;
                # Only the path to the generated file is passed here. The old PORT /
                # DOCLIGHT_HOST / DOCLIGHT_STRICT_PORT entries are intentionally gone:
                # those keys now live in the TOML, and leaving them in the environment
                # would let them override the file (env beats file), silently making
                # `settings.port` ineffective. Store paths contain no spaces, so the
                # list form is safe for DOCLIGHT_CONFIG.
                Environment = [
                  "DOCLIGHT_CONFIG=${configFile}"
                ];
                # DOCLIGHT_DATA_DIR is kept as an explicit alignment with the systemd
                # state directory below: the same value is in the TOML, but systemd —
                # not the app — decides where the writable directory actually is, and
                # the two must not disagree. It goes through `environment` (an attrset
                # quoted via toJSON), never the bare-string list:
                # list elements are unquoted, so a value with a space would be parsed
                # by systemd as a second assignment and silently truncated (observed:
                # `© 2026 Mooling` became `©`). The store copy is read-only;
                # pages/*.md, spaces.json and auth.json live in the state directory, which systemd
                # also makes writable for the dynamic user.
                StateDirectory = "doclight";
                WorkingDirectory = "/var/lib/doclight";
                Restart = "on-failure";
                RestartSec = 3;
                DynamicUser = true;
                NoNewPrivileges = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
              };

              # `environment` is a service-level option and must sit alongside
              # serviceConfig.
              environment = {
                DOCLIGHT_DATA_DIR = "/var/lib/doclight";
              };
            };

            networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ effectivePort ];
          };
        };
    };
}
