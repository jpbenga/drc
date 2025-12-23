{ pkgs, ... }: {
  channel = "stable-24.05";
  packages = [
    pkgs.stdenv.cc.cc.lib
    pkgs.python311
    pkgs.python311Packages.pip
    pkgs.nodejs_20
  ];
  env = {
    # CETTE LIGNE EST CRUCIALE POUR RÉPARER L'ERREUR NUMPY
    LD_LIBRARY_PATH = "${pkgs.stdenv.cc.cc.lib}/lib";
  };
  idx = {
    extensions = [ "google.gemini-cli-vscode-ide-companion" ];
    previews = {
      enable = true;
      previews = {};
    };
    workspace = {
      onCreate = {
        default.openFiles = [ "optimizer.py" "backtest.js" ];
      };
    };
  };
}