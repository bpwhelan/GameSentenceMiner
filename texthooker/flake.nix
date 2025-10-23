{
  description = "texthooker-ui";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        name = "texthooker-ui";
        src = ./.;
        pkgs = import nixpkgs {inherit system;};
        nativeBuildInputs = with pkgs; [nodejs pnpm.configHook];
      in {
        # index.html will be located in the nix store
        # build with "nix build . --print-out-paths" to get the path
        packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
          inherit name nativeBuildInputs src;
          pname = name;

          pnpmDeps = pkgs.pnpm.fetchDeps {
            pname = name;
            inherit src;
            hash = "sha256-Wqs3aO4uq/5eqVmp9FFZNVEWo/TpwDib9PJFABmFrbk=";
          };

          installPhase = ''
            pnpm run build
            cp -r ./docs $out
          '';
        });

        devShell = pkgs.mkShell {
          inherit nativeBuildInputs;
        };
      }
    );
}
