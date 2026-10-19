export interface Evento {
  fuente: string;
  id: string;
  titulo: string;
  inicio: string; // ISO con offset
  fin?: string;
  lugar?: string;
  barrio?: string;
  online?: boolean;
  gratis?: boolean | null;
  precio?: string;
  categoria?: string;
  organizador?: string;
  url: string;
  descripcion?: string;
}

export interface Consulta {
  texto?: string;
  desde: Date;
  hasta: Date;
  ciudad: string;
}

export interface Estrategia {
  nombre: string;
  correr(c: Consulta): Promise<Evento[]>;
}

export interface Fuente {
  nombre: string;
  estrategias: Estrategia[]; // se prueban en orden, gana la primera que devuelve algo
}
