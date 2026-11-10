use crate::PreviewPort;
use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub port: u16,
    pub address: String,
    pub process: Option<String>,
    pub preview_host_port: Option<u16>,
}

pub fn parse(output: &str, previews: &[PreviewPort]) -> Vec<ListeningPort> {
    let mut ports = Vec::new();
    for line in output.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 || fields[0] != "LISTEN" {
            continue;
        }
        let Some((address, port)) = fields[3].rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port.parse::<u16>() else {
            continue;
        };
        let process = fields
            .get(5..)
            .filter(|fields| !fields.is_empty())
            .map(|fields| fields.join(" ").chars().take(256).collect());
        ports.push(ListeningPort {
            port,
            address: address.into(),
            process,
            preview_host_port: previews
                .iter()
                .find(|preview| preview.guest == port)
                .map(|preview| preview.host),
        });
    }
    ports.sort_by(|left, right| (left.port, &left.address).cmp(&(right.port, &right.address)));
    ports
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_guest_services_without_treating_them_as_exposed_previews() {
        let ports = parse("LISTEN 0 511 0.0.0.0:3010 0.0.0.0:* users:((\"bun\",pid=42,fd=7))\nLISTEN 0 4096 [::]:22 [::]:*\nLISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\n", &[PreviewPort { guest: 3010, host: 3030 }]);
        assert_eq!(
            ports.iter().map(|port| port.port).collect::<Vec<_>>(),
            vec![22, 3010, 5432]
        );
        assert_eq!(ports[0].address, "[::]");
        assert_eq!(ports[0].preview_host_port, None);
        assert_eq!(ports[1].preview_host_port, Some(3030));
        assert!(ports[1].process.as_ref().unwrap().contains("bun"));
        assert_eq!(ports[2].preview_host_port, None);
    }
}
