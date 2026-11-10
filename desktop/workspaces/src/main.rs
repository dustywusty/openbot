use openbot_workspaces::{default_root, BaseImage, Manager, Recipe};
use std::{env, path::PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    let root = if args.first().map(String::as_str) == Some("--root") {
        if args.len() < 3 {
            return Err("Use --root <directory> <command>.".into());
        }
        let root = PathBuf::from(args.remove(1));
        args.remove(0);
        root
    } else {
        default_root()?
    };
    let manager = Manager::new(root)?;
    let command = args.first().map(String::as_str).unwrap_or("help");
    let id = || {
        args.get(1)
            .map(String::as_str)
            .ok_or_else(|| "Choose a workspace id.".to_owned())
    };
    let output = match command {
        "check" => serde_json::json!({"provider":manager.prerequisites()?}),
        "recipe" => {
            let image = match args.get(1).map(String::as_str) {
                None | Some("debian13") => BaseImage::Debian13,
                Some("ubuntu2404") => BaseImage::Ubuntu2404,
                Some(_) => return Err("Choose debian13 or ubuntu2404.".into()),
            };
            serde_json::to_value(Recipe::for_image(image)).map_err(|e| e.to_string())?
        }
        "create" => {
            let path = args.get(1).ok_or("Use create <recipe.json>.")?;
            let recipe: Recipe =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            serde_json::to_value(manager.create(recipe)?).map_err(|e| e.to_string())?
        }
        "list" => serde_json::to_value(manager.list()?).map_err(|e| e.to_string())?,
        "status" => {
            serde_json::json!({"workspace":manager.get(id()?)?,"vmStatus":manager.vm_status(id()?)?})
        }
        "logs" => {
            print!("{}", manager.logs(id()?)?);
            return Ok(());
        }
        "ports" => serde_json::to_value(manager.ports(id()?)?).map_err(|e| e.to_string())?,
        "models" => {
            serde_json::to_value(manager.codex_models(id()?)?).map_err(|e| e.to_string())?
        }
        "prepare" => serde_json::to_value(manager.prepare(id()?, |event| {
            eprintln!("[{}] {}", event.stage, event.message)
        })?)
        .map_err(|e| e.to_string())?,
        "stop" => serde_json::to_value(manager.stop(id()?, |event| {
            eprintln!("[{}] {}", event.stage, event.message)
        })?)
        .map_err(|e| e.to_string())?,
        "exec" => {
            manager.execute(id()?, &args[2..], &mut |event| {
                println!("{}", event.message)
            })?;
            return Ok(());
        }
        "shell" => {
            manager.shell(id()?)?;
            return Ok(());
        }
        _ => {
            println!("OpenBot native workspace development tool\n\ncheck | recipe | create <recipe.json> | list | status <id> | prepare <id>\nlogs <id> | models <id> | ports <id> | stop <id> | exec <id> <guest-command> [args] | shell <id>\n\nNo HTTP service. The desktop uses this same native library.");
            return Ok(());
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|e| e.to_string())?
    );
    Ok(())
}
