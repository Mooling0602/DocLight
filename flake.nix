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
          version = "1.0.0";
          src = self;

          # Regenerate after touching package.json or package-lock.json:
          #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          # The lockfile pins a native compiler binary per platform via
          # optionalDependencies, so the cache is ~184 MB even though only one
          # platform's binary is ever unpacked. That is unavoidable: one hash has
          # to cover every platform, and it is what makes aarch64 builds work.
          npmDepsHash = "sha256-nX46rQidiGK1tQroIcz+QVfrnduORdRcnjueS6mv1Qg=";

          # `npm run build` compiles the server, the browser bundle and the tests.
          npmBuildScript = "build";

          # The runtime has no dependencies at all (typescript and jsdom are
          # build/test-only), so a custom install phase ships exactly dist/server.js
          # plus the static assets. Two reasons not to use npmInstallHook here:
          #   - `npm pack` honours .gitignore, which lists dist/ and public/app.js,
          #     so the generated artifacts would be dropped from the output;
          #   - `npm prune --omit=dev` has nothing left to keep and may reach for
          #     the network, which the sandbox forbids.
          # The compiled tests are deliberately not shipped: they import jsdom.
          #
          # Layout matters: server.js resolves its root as `__dirname/..` and then
          # looks for `public/` next to it, so the file has to keep its `dist/`
          # level — `lib/doclight/dist/server.js` makes `lib/doclight` the root.
          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/doclight/dist
            cp dist/server.js dist/beian.js $out/lib/doclight/dist/
            cp -r public $out/lib/doclight/

            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/doclight \
              --add-flags $out/lib/doclight/dist/server.js \
              --run 'if [ -z "''${DOCLIGHT_DATA_DIR:-}" ]; then export DOCLIGHT_DATA_DIR="''${XDG_DATA_HOME:-$HOME/.local/share}/doclight"; fi'

            runHook postInstall
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];

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
      # PORT=8080 nix run .    → start scanning from another port
      # DOCLIGHT_DATA_DIR=/tmp/docs nix run .
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
        in
        {
          options.services.doclight = {
            enable = lib.mkEnableOption "DocLight 轻量可视化文档站";

            package = lib.mkOption {
              type = lib.types.package;
              default = pkg;
              description = "DocLight 包。";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 4173;
              description = "监听端口。";
            };

            address = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              description = ''
                监听地址。默认只绑定回环，公网访问请经反向代理转发；
                需要直接对外暴露时可设为 "0.0.0.0" 并打开 openFirewall。
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
                # Port is fixed; automatic probing is disabled (the reverse proxy
                # points at a single port, and silent drift would make it miss).
                Environment = [
                  "PORT=${toString cfg.port}"
                  "DOCLIGHT_HOST=${cfg.address}"
                  "DOCLIGHT_DATA_DIR=/var/lib/doclight"
                  "DOCLIGHT_STRICT_PORT=1"
                ];
                # Filing info must go through `environment` (an attrset) and cannot
                # be merged into the Environment list above: list elements are bare
                # strings, nixpkgs does not add quotes, and a copyright line with a
                # space would be parsed by systemd as a second assignment and
                # silently truncated (observed: `© 2026 Mooling` became `©`). An
                # attrset is quoted via toJSON, so CJK text and spaces pass through
                # intact.
                # Note that `environment` is a service-level option and must sit
                # alongside serviceConfig.
                # The store copy is read-only; pages.json and auth.json live in the
                # state directory, which systemd also makes writable for the
                # dynamic user.
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

              # Filing number / copyright line (shown at the page bottom). Unset
              # values are omitted entirely so no empty variables reach the
              # environment. `environment` is a service-level option and must sit
              # alongside serviceConfig.
              environment = lib.filterAttrs (_: v: v != null) {
                DOCLIGHT_ICP = cfg.icp;
                DOCLIGHT_ICP_URL = cfg.icpUrl;
                DOCLIGHT_POLICE = cfg.police;
                DOCLIGHT_POLICE_URL = cfg.policeUrl;
                DOCLIGHT_COPYRIGHT = cfg.copyright;
              };
            };

            networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
          };
        };
    };
}
