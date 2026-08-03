/* export/bids.js — exportação em estrutura BIDS-like (iEEG).

   HONESTIDADE DE NOME. Isto NÃO é um dataset BIDS certificado: o BIDS-iEEG
   exige campos que o Session Report do Percept simplesmente não traz
   (coordenadas dos eletrodos, referência do sistema, tipo de eletrodo por
   contato, protocolo de tarefa). O que este módulo produz é a ESTRUTURA de
   diretórios, a nomenclatura e os arquivos de metadados no formato do BIDS, com
   os campos disponíveis preenchidos e os ausentes marcados como `n/a` — que é
   exatamente o que o BIDS manda fazer com o que não se sabe. É o suficiente
   para o dado entrar em ferramentas que leem BIDS, e insuficiente para chamar
   de conforme. O `dataset_description.json` diz isso explicitamente.

   Referência: Holdgraf C, et al. Sci Data 2019;6:102 (BIDS-iEEG).            */

import { hashId } from '../io/parse.js';

const na = v => (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) ? 'n/a' : v;
const tsv = (colunas, linhas) =>
  [colunas.join('\t')].concat(linhas.map(l => colunas.map(c => String(na(l[c]))).join('\t'))).join('\n') + '\n';

/* buildBidsLike(parsedList, opts) → [{ path, content }] */
export function buildBidsLike(parsedList, opts) {
  opts = opts || {};
  const lista = (parsedList || []).filter(Boolean);
  if (!lista.length) return null;
  const arquivos = [];

  arquivos.push({
    path: 'dataset_description.json',
    content: JSON.stringify({
      Name: opts.name || 'Percept LFP — exportação do Percept LFP Studio',
      BIDSVersion: '1.9.0',
      DatasetType: 'raw',
      GeneratedBy: [{ Name: 'Percept LFP Studio', Version: opts.appVersion || '0.6.0' }],
      Acknowledgements: 'Dados pseudonimizados na origem: nome, data de nascimento, PatientId e número de série ' +
        'do neuroestimulador não saem do leitor de arquivo.',
      HowToAcknowledge: 'n/a',
      ConformanceNote: 'ESTRUTURA BIDS-like, NÃO um dataset BIDS conforme. O Session Report do Percept não traz ' +
        'coordenadas de eletrodo, sistema de referência nem protocolo de tarefa; esses campos estão marcados como ' +
        '"n/a". Valide com o bids-validator antes de qualquer uso que exija conformidade.'
    }, null, 2)
  });

  /* participants.tsv — um por sujeito pseudonimizado */
  const porSujeito = new Map();
  lista.forEach(p => {
    const id = (p.patient && p.patient.idHash) || hashId(p.fileName || 'x');
    if (!porSujeito.has(id)) porSujeito.set(id, []);
    porSujeito.get(id).push(p);
  });
  const participantes = [];
  porSujeito.forEach((ps, id) => {
    const p0 = ps[0];
    participantes.push({
      participant_id: 'sub-' + id.replace(/^sub-/, ''),
      diagnosis: na(p0.patient && p0.patient.diagnosis),
      sex: na(p0.patient && p0.patient.sex),
      implant_date: na(p0.device && String(p0.device.implantDate || '').slice(0, 10)),
      device_model: na(p0.device && p0.device.model),
      firmware: na(p0.device && p0.device.firmware),
      targets: (p0.leads || []).map(l => `${l.hemisphere}:${l.target}`).join(',') || 'n/a',
      n_sessions: ps.length
    });
  });
  arquivos.push({
    path: 'participants.tsv',
    content: tsv(['participant_id', 'diagnosis', 'sex', 'implant_date', 'device_model', 'firmware', 'targets', 'n_sessions'], participantes)
  });
  arquivos.push({
    path: 'participants.json',
    content: JSON.stringify({
      participant_id: { Description: 'identificador pseudonimizado, derivado por hash na borda do leitor' },
      diagnosis: { Description: 'diagnóstico registrado no Session Report' },
      implant_date: { Description: 'data de implante do neuroestimulador', Units: 'YYYY-MM-DD' },
      targets: { Description: 'alvo por hemisfério, como registrado no arquivo' }
    }, null, 2)
  });

  /* por sessão: channels.tsv, ieeg.json, events.tsv e o sinal em TSV */
  porSujeito.forEach((ps, id) => {
    const sub = 'sub-' + id.replace(/^sub-/, '');
    ps.slice().sort((a, b) => String(a.meta.sessionStart || '').localeCompare(String(b.meta.sessionStart || '')))
      .forEach((p, iSes) => {
        const ses = 'ses-' + String(iSes + 1).padStart(2, '0');
        const base = `${sub}/${ses}/ieeg/${sub}_${ses}_task-rest_`;
        const tds = (p.bsTimeDomain || []).concat(p.montageTD || []);

        const canais = tds.map(td => ({
          name: td.label, type: 'DBS', units: 'uV',
          low_cutoff: 'n/a', high_cutoff: 'n/a',
          reference: 'bipolar entre os contatos indicados no nome do canal',
          sampling_frequency: isFinite(td.fsEff) ? +td.fsEff.toFixed(4) : td.fs,
          notch: 'n/a',
          status: (td.packets && td.packets.pctMissing > 10) ? 'bad' : 'good',
          status_description: td.packets && isFinite(td.packets.pctMissing)
            ? `${td.packets.pctMissing.toFixed(2)}% de amostras perdidas (preservadas como NaN)` : 'n/a'
        }));
        if (canais.length) arquivos.push({
          path: base + 'channels.tsv',
          content: tsv(['name', 'type', 'units', 'low_cutoff', 'high_cutoff', 'reference', 'sampling_frequency', 'notch', 'status', 'status_description'], canais)
        });

        const fs0 = tds.length ? (tds[0].fsEff || tds[0].fs) : null;
        arquivos.push({
          path: base + 'ieeg.json',
          content: JSON.stringify({
            TaskName: 'rest',
            InstitutionName: 'n/a',
            Manufacturer: 'Medtronic',
            ManufacturersModelName: na(p.device && p.device.model),
            SoftwareVersions: na(p.meta && p.meta.programmerVersion),
            SamplingFrequency: na(fs0),
            PowerLineFrequency: na(opts.powerLineHz),
            SoftwareFilters: 'n/a',
            HardwareFilters: { note: 'passa-alta do dispositivo, não exposta no Session Report' },
            RecordingDuration: tds.length && fs0 ? +(tds[0].data.length / fs0).toFixed(3) : 'n/a',
            RecordingType: 'continuous',
            iEEGReference: 'bipolar entre contatos do próprio eletrodo de DBS',
            ElectrodeManufacturer: 'Medtronic',
            iEEGElectrodeGroups: (p.leads || []).map(l => `${l.hemisphere}:${l.target}:${l.model || 'n/a'}`).join('; ') || 'n/a',
            DBSParameters: {
              note: 'parâmetros de estimulação vigentes no momento do registro, quando declarados no arquivo'
            },
            MissingDataPolicy: 'perda de pacote preservada como NaN; nada foi interpolado',
            SessionStart: na(p.meta && p.meta.sessionStart),
            NonConformanceNote: 'coordenadas de eletrodo e sistema de referência anatômica não constam do ' +
              'Session Report do Percept e não podem ser inventados aqui'
          }, null, 2)
        });

        /* eventos do paciente */
        const eventos = (p.snapshots || []).map(s => ({
          onset: isFinite(s.t) && p.meta.sessionStart ? +((s.t - Date.parse(p.meta.sessionStart)) / 1000).toFixed(3) : 'n/a',
          duration: 0, trial_type: s.name || 'evento', value: 'n/a'
        }));
        if (eventos.length) arquivos.push({
          path: base + 'events.tsv',
          content: tsv(['onset', 'duration', 'trial_type', 'value'], eventos)
        });

        /* sinal bruto em TSV — o BIDS-iEEG prefere BrainVision/EDF/NWB; aqui o
           TSV acompanha o EDF gerado à parte, e isso fica dito */
        if (opts.includeSignalTsv !== false && tds.length) {
          const n = Math.min.apply(null, tds.map(t => t.data.length));
          const linhas = [tds.map(t => t.label).join('\t')];
          for (let i = 0; i < n; i++) linhas.push(tds.map(t => isFinite(t.data[i]) ? t.data[i].toFixed(4) : 'n/a').join('\t'));
          arquivos.push({ path: base + 'ieeg.tsv', content: linhas.join('\n') + '\n' });
        }
      });
  });

  return arquivos;
}
