export const permitted=user=>['cesar.bravo','jonas.aragao'].includes(user?.login);
export const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export function demand(condition,message,status=400){if(!condition)throw Object.assign(new Error(message),{status});}
export const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const failure=error=>reply({error:error.status?error.message:'Falha no servidor. O salvamento não foi confirmado.'},error.status||503);
export async function requireUser(){throw Object.assign(new Error('Entre no Hub CN2O.'),{status:401});}
